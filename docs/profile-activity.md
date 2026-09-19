# Profile activity

This repository contains a dependency-free Node.js collector and publisher for an optional profile activity graph.

The collector converts explicitly allowed local Codex JSONL records into private daily snapshots. Raw prompts, responses, tool arguments, paths, session identifiers, source identifiers, credentials, device details, model names, and skill or plugin names are never public output. The public schema contains only a 30-day date window, coverage, aggregate counts, durations, streaks, and fixed labels.

`activeSessions` is a daily logical-session count, so its period total is labelled **Session-days**, not unique sessions. `toolCalls` counts observed tool-call requests, not successful work, code volume, or productivity. Token counts are deltas of locally observed cumulative Codex session telemetry; they are not OpenAI billing, quota, cost, or an official account-wide usage report. Missing or unverified data remains unavailable rather than becoming zero. When the two sources are not verified as independent, additive metrics publish only the greater per-day observation and are labelled as a conservative lower bound.

## Development checks

```sh
node --test tests/profile-activity/*.test.mjs
node scripts/profile-activity/install-local.mjs --plan --role collector
node scripts/profile-activity/install-local.mjs --plan --role publisher
```

An approved installation copies runtime files from an exact full Git commit, never from the working tree:

```sh
node scripts/profile-activity/install-local.mjs --apply --config PRIVATE_CONFIG_FILE --source-commit APPROVED_FULL_COMMIT
```

Removal accepts only the installed private config and refuses a changed receipt, runtime, or unmanaged runtime file. Collector scheduling and publisher scheduling remain separate approvals.

Actual config, snapshots, cache, runtime receipts, transport paths, and scheduler registration stay outside the repository. `probe` reports only field/type/event-kind counts. `collect --dry-run` reads the selected scope without persisting a snapshot. Publisher dry runs render private previews; only an approved publisher installation may commit the two generated files.

## Direct Codex relay

Two fixed private Codex tasks relay only the sanitized schema v2 envelope. The MacBook collector runs at login and every 15 minutes while the device is awake. Its sender retains the first daily envelope across restarts, retries that exact envelope at most four times, and stops after a matching acknowledgement.

The Mac mini receiver validates the envelope digest, registered source, revision ordering, and conflict rules before atomically replacing last-good. It never derives correctness from task memory. A successful receive after 08:00 KST is followed by the same gated `run` command used by the daily 08:00 heartbeat.

The publisher writes at most one receipt per KST date. It publishes only when both registered snapshots are schema v2 and end on that date. Before 08:00 it returns `before-window`; without a current MacBook snapshot it returns `awaiting-source`; after a successful publication it returns `already-published`. These safe skips preserve the previous public result.

Recurrence must remain attached to the two existing tasks. It must not create a task per run, keep a device awake, or use a shared folder. To recover, pause both task heartbeats first, unload only the owned collector job, then restore the verified runtime and scheduler definitions from private receipts. Do not remove source logs or private snapshots during rollback.

`partial` is a data-coverage state, not a security fallback. It may publish only after both registered sources have produced valid evidence and every runtime, target, hook, path, and schema check succeeds. `unavailable` never publishes.

The runtime is installed as a content-addressed copy and checked against its manifest on every run. A single private lock and isolated candidate worktree protect the user's checkout. Publishing refuses unexpected repositories, remotes, hooks, staged paths, or runtime changes and never force-pushes.

To stop automation, pause the owned publisher schedule first, then unload only the owned collector job. Do not delete source logs or credentials. A bad public graph should be reverted with a normal reviewed commit; suspected sensitive-data exposure requires separate credential and Git-history handling.
