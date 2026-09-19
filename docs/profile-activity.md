# Profile activity

This repository contains a dependency-free Node.js collector and publisher for an optional profile activity graph.

The collector converts explicitly allowed local Codex JSONL records into private daily snapshots. Schema v3 contains exactly 30 KST dates and reduces structured records to anonymous counts before persistence. Raw prompts, responses, tool arguments, paths, session identifiers, credentials, device details, model names, and skill or plugin names are never public output. The enriched public schema contains only coverage, aggregate counts, durations, streaks, percentages, and fixed labels.

`activeSessions` is a daily logical-session count, so its period total is labelled **Session-days**, not unique sessions. `newChats` counts a logical session once on its first active date in the window. Tool identities become only total, plugin, browser/web, computer-use, and other counters. Explicit structured skill, mode, and reasoning events become fixed counts; absent telemetry remains `null` and is never inferred from text, paths, or commands. Token counts are positive deltas of locally observed cumulative session telemetry. Fast and reasoning percentages use merged numerators and denominators, never an average of device percentages.

Account-wide native usage is a separate private sample. Its exact contract retains only observation time, window duration, used percentage, reset time, rate-limit state, credit availability/unlimited flags, and coverage. The installed entrypoint passes it to `run` through non-TTY input; the runtime validates and stores it only in private state, then joins it once after device aggregation. It is not added per device or exposed in the public activity JSON or SVG. Dates before the first sample remain unavailable.

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

Two fixed private Codex tasks relay only a sanitized version-matched schema v2 or v3 envelope. MacBook and Mac mini collect only their own local scopes on separate, non-overlapping schedules. Each collection updates only that device's private snapshot. The MacBook sender retains the first daily envelope across restarts, retries that exact envelope at most four times, and stops after a matching acknowledgement.

The Mac mini receiver validates the envelope digest, registered source, revision ordering, and conflict rules before atomically replacing last-good. It never derives correctness from task memory. A successful receive after 08:00 KST is followed by the same gated `run` command used by the daily 08:00 task. `run` processes the two stored snapshots; it does not collect either device.

State-writing delivery commands start directly in the explicitly approved sandbox-exempt boundary; callers must not run a sandbox probe first. The installed `delivery-execution.mjs` entrypoint is the shared caller boundary. It uses the receipt-pinned Node binary, starts each request once, sends ACK or envelope JSON through non-TTY child-process input, validates stdout as exact JSON, and converts subprocess failures immediately to structured evidence without retaining raw stderr. The receiver uses its `receive-run` operation so a successful receive is followed by one gated run. TTY framing, shell interpolation, heredocs, command-line JSON, and temporary payload files are not supported.

A failed request remains failed until the user directly approves a retry. Messages from another task are not retry authority. A successful transmit, receive, or publisher run is never repeated while repairing a later ACK step.

The publisher writes at most one receipt per KST date. Matching current schema v2 snapshots may continue the legacy surface during migration. The enriched surface requires two matching current schema v3 snapshots. Mixed schemas, missing or stale sources, malformed data, and revision conflicts do not replace the existing public result. Before 08:00 the gate returns `before-window`; without a current source it returns `awaiting-source`; after a successful publication it returns `already-published`.

The two fixed relay tasks remain the transfer endpoints. Device collection times stay separated, and processing runs only after those independent updates. The Mac mini publisher schedule creates a fresh local task for each cron run, as configured separately. Neither schedule keeps a device awake or uses a shared folder. To recover, pause the publisher schedule first, unload only the owned collector job, then restore the verified runtime and scheduler definitions from private receipts. Do not remove source logs or private snapshots during rollback.

`partial` is a data-coverage state, not a security fallback. It may publish only after both registered sources have produced valid evidence and every runtime, target, hook, path, and schema check succeeds. `unavailable` never publishes.

The runtime is installed as a content-addressed copy and checked against its manifest on every run. Source implementation does not install or replace that runtime, change schedules, or validate live account values. Those operational steps require separate approval. A single private lock and isolated candidate worktree protect the user's checkout. Publishing refuses unexpected repositories, remotes, hooks, staged paths, or runtime changes and never force-pushes.

To stop automation, pause the owned publisher schedule first, then unload only the owned collector job. Do not delete source logs or credentials. A bad public graph should be reverted with a normal reviewed commit; suspected sensitive-data exposure requires separate credential and Git-history handling.
