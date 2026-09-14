# Profile activity

This repository contains a dependency-free Node.js collector and publisher for an optional profile activity graph.

The collector converts explicitly allowed local Codex JSONL records into private daily snapshots. Raw prompts, responses, tool arguments, paths, session identifiers, source identifiers, credentials, and device details are never public output. The public schema contains only a 30-day date window, coverage, active-day/session-day/tool-call counts, and fixed labels.

`activeSessions` is a daily logical-session count, so its period total is labelled **Session-days**, not unique sessions. `toolCalls` counts observed tool-call requests, not successful work, code volume, or productivity. Missing or unverified data remains unavailable rather than becoming zero. Tokens and costs are intentionally unsupported.

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

`partial` is a data-coverage state, not a security fallback. It may publish only after both registered sources have produced valid evidence and every runtime, target, hook, path, and schema check succeeds. `unavailable` never publishes.

The runtime is installed as a content-addressed copy and checked against its manifest on every run. A single private lock and isolated candidate worktree protect the user's checkout. Publishing refuses unexpected repositories, remotes, hooks, staged paths, or runtime changes and never force-pushes.

To stop automation, pause the owned publisher schedule first, then unload only the owned collector job. Do not delete source logs or credentials. A bad public graph should be reverted with a normal reviewed commit; suspected sensitive-data exposure requires separate credential and Git-history handling.
