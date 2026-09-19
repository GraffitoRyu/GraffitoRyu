# Profile activity direct communication design

**Date:** 2026-09-19  
**Status:** Pending written review

## Intent

Publish one daily Codex activity update after 08:00 KST only when both registered devices have produced a valid snapshot for that date. The MacBook may sleep or remain offline indefinitely. Its first usable snapshot after the user resumes the device completes the daily input set.

Codex tasks carry the sanitized snapshot directly between devices. No shared cloud folder, always-on network service, sleep prevention, GitHub Action, or new task per execution is required.

## Constraints

- Raw Codex JSONL, prompts, responses, tool arguments, credentials, local paths, device identifiers, and source identifiers never enter a model prompt or public output.
- The user accepts that the sanitized private snapshot passes through private Codex task history.
- Collection and publication use only installed, digest-verified runtime code.
- The publisher remains the only installation allowed to change `metrics/codex-activity.json` and `assets/codex-activity.svg`.
- A missing MacBook snapshot skips that day's publication and preserves the previous public result.
- Publication occurs at most once per KST date.
- Recurrence reuses fixed sender and receiver tasks. It must not create a new visible task for each run.

## Components

### MacBook collector

The existing native collector job runs every 15 minutes while the user session and device are available. Sleep naturally suspends execution. After resume, the next interval creates a schema v2 snapshot without requiring the Codex model to read raw logs.

The collector writes only to its existing private state. Scheduling does not keep the device awake or force network connectivity.

### Fixed MacBook sender task

A heartbeat attached to one fixed sender task checks the installed collector's sanitized snapshot every 15 minutes. It sends only a schema-valid snapshot whose revision has not been acknowledged by the receiver.

The sender uses the installed validator to create this envelope:

```json
{
  "schema": "PROFILE_ACTIVITY_SNAPSHOT_V2",
  "revision": 1,
  "digest": "sha256-of-canonical-snapshot",
  "snapshot": {}
}
```

`digest` is envelope metadata. It is not required inside `snapshot`.

### Fixed Mac mini receiver task

One fixed receiver task accepts envelopes from the registered sender task. Correctness does not depend on task memory or model interpretation. Installed runtime code performs all validation and private writes.

The receiver:

1. validates the envelope and schema v2 snapshot;
2. recalculates the canonical snapshot digest;
3. verifies the registered source and policy;
4. rejects revision rollback and same-revision digest conflicts;
5. atomically replaces the private last-good snapshot only after every check succeeds;
6. returns an acknowledgement containing only revision, digest, and success or failure.

The existing stale schema v1 transport input remains untouched until the first valid schema v2 envelope succeeds.

### Mac mini publisher

The receiver task also owns a daily 08:00 KST heartbeat. Both the heartbeat and a successful post-08:00 receive call the same installed publisher gate.

The gate publishes only when all conditions hold:

- current time is at or after 08:00 KST;
- local and received snapshots both use schema v2;
- both snapshot windows end on the current KST date;
- both snapshots pass source, policy, freshness, and digest checks;
- no successful publication receipt exists for the current KST date.

If both snapshots are ready before 08:00, the heartbeat publishes at 08:00. If the MacBook first becomes available after 08:00, successful receipt triggers that day's first publication immediately. If no current MacBook snapshot arrives, publication is skipped for the date.

## State and idempotency

Runtime-owned private state records the last acknowledged sender revision and the last successfully published KST date. Automation memory is diagnostic only and is not a correctness source.

- Repeating the same revision and digest is an idempotent acknowledgement.
- A lower revision is rejected as rollback.
- The same revision with a different digest is rejected as conflict.
- A higher valid revision replaces last-good.
- A second publish request on the same date returns a no-op.
- A skipped date does not receive a synthetic zero or stale publication receipt.

## Retry and failure behavior

If the sender receives no valid acknowledgement, it retries the identical revision at the next 15-minute heartbeat, up to four attempts that day. It never recollects or mutates the snapshot as part of a delivery retry.

Receiver validation failure preserves last-good and reports only the failed validation stage. Publisher failure preserves the previous public result and stops after the runtime's existing bounded retry policy. Automatic turns do not repair configuration, widen permissions, replace runtime code, or create fallback data.

After four delivery failures or one terminal publisher failure, automation stops retrying for that date and leaves one actionable notification. A later manual retry must use the same installed runtime and private state.

## Privacy boundary

The snapshot in the envelope contains sanitized daily aggregates but remains private. It may exist in the two fixed Codex task histories and installed private state only. It must not be committed, copied into automation memory, quoted in user-facing reports, or written to public artifacts.

User-facing reports contain only stage, success or failure, revision acknowledgement, publication status, and public commit when present.

## Verification

Automated checks cover:

1. a valid MacBook snapshot received before 08:00 and published once at 08:00;
2. a valid first snapshot received after 08:00 and published immediately;
3. no current MacBook snapshot and no publication for that date;
4. duplicate, rollback, conflict, malformed, and digest-mismatched envelopes;
5. delivery retry acknowledgement and four-attempt stop;
6. same-date publication idempotency;
7. preservation of the last public result on receive or publish failure;
8. absence of private fields and values from public artifacts and reports.

The rollout requires one manual end-to-end verification across the two fixed tasks before recurrence is enabled. Success means the MacBook produces a current schema v2 snapshot, the Mac mini acknowledges and stores it, exactly one publication changes only the two generated public files, and no extra task is created.

## Rollout and recovery

1. Implement and test the envelope receiver, acknowledgement, date gate, and receipt state in repository source.
2. Install the approved runtime on the Mac mini and verify a receive-only dry run without publication.
3. Install the approved runtime on the MacBook and verify one manual send and acknowledgement.
4. Run one controlled post-08:00 publication and verify the remote commit and clean worktree.
5. Replace the old standalone cron definitions with heartbeats on the two fixed tasks.
6. Enable the MacBook collector interval only after the end-to-end check passes.

Rollback pauses both heartbeats first, restores the previous installed runtime and scheduler definitions from their private receipts, and leaves the last public result unchanged. Source logs and private snapshots are never deleted during rollback.

## Non-goals

- Rewriting existing Git history or activity commits
- Publishing more than once per day
- Keeping either device awake
- Adding iCloud, a custom server, database, queue, or third-party dependency
- Treating missing data as zero
- Using task prose or automation memory to validate snapshot contents
