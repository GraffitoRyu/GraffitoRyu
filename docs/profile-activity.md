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

Actual config, private snapshots, cache, runtime receipts, and scheduler registration stay outside the repository. `probe` reports only field/type/event-kind counts. `collect --dry-run` reads the selected scope without persisting a snapshot. Only an approved installed device publisher may commit its owned anonymous collection and, when both collections are current and valid, the three final generated files.

## Direct repository publication

MacBook and Mac mini collect only their own local scopes on separate, non-overlapping schedules. There is no device-to-device envelope, receiver, acknowledgement, task payload, or shared transport folder. Each installed `run` projects its local private schema v3 snapshot into one fixed public collection file and publishes that file directly through an isolated Git candidate worktree.

The public collection schema contains only `schemaVersion`, a fixed metric scope, KST timezone, the exact 30-day window, and anonymous daily counters. It excludes private routing metadata including source or device ID, revision, policy label, collection timestamp, digest, paths, and task/session identity. The fixed filename and private installed config define ownership; the JSON does not serialize that binding.

Each Git attempt fetches the newest target branch and creates a fresh detached candidate. The publisher writes only its owned collection, then strictly reads both canonical collection files from that candidate. When both match the current KST 30-day window and the merged activity is publishable, it regenerates `metrics/codex-activity.json`, `assets/codex-activity.svg`, and `assets/codex-activity-ko.svg`. Missing, malformed, wrong-window, or unavailable input leaves those final files byte-for-byte unchanged while still allowing the valid owned collection to advance.

Non-fast-forward publication retries repeat the entire fetch, candidate, collection validation, merge, and render sequence, so a concurrent peer update is never overwritten by a stale final render. A device-local private lock prevents duplicate runs on one machine. The staged and committed path allowlist contains only the configured owned collection plus the three final generated files; README, source, the peer collection, and private state are refused. Pushes are bounded and never forced.

A failed state-changing request remains failed until the user directly approves a retry. Messages from another task are not retry authority. A successful publisher run is not repeated.

The two device schedules stay separated. Each schedule collects locally and publishes directly; whichever valid collection lands second refreshes the final merged view. Neither schedule keeps a device awake. To recover, pause the affected schedule, restore the verified runtime and private configuration from its receipt, and preserve source logs and private snapshots.

`partial` is a data-coverage state, not a security fallback. It may publish only after both registered sources have produced valid evidence and every runtime, target, hook, path, and schema check succeeds. `unavailable` never publishes.

The runtime is installed as a content-addressed copy and checked against its manifest on every run. Source implementation does not install or replace that runtime, change schedules, or validate live account values. Those operational steps require separate approval. A single private lock and isolated candidate worktree protect the user's checkout. Publishing refuses unexpected repositories, remotes, hooks, staged paths, or runtime changes and never force-pushes.

To stop automation, pause the owned publisher schedule first, then unload only the owned collector job. Do not delete source logs or credentials. A bad public graph should be reverted with a normal reviewed commit; suspected sensitive-data exposure requires separate credential and Git-history handling.
