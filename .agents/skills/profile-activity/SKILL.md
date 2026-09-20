---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. The Mac mini schedule runs the installed `run` command once at 00:30 UTC each day.
2. Start the state-writing command exactly once in the user's approved sandbox-exempt boundary. Do not probe it in the sandbox first.
3. The installed runtime reads account token activity only through the official Codex App Server and validates the reduced public schema before publication.
4. Public output contains only the five account token summaries, the exact 30-day daily token series, fixed schema metadata, and fixed labels. Never expose raw responses, paths, account details, credentials, task/thread identifiers, plugin or skill names, or local configuration.
5. Treat `published` and `no-op` as success and `skipped-lock` as a safe skip.
6. Stop on collection, validation, retry exhaustion, runtime, repository, remote, hook, allowlist, permission, or invocation errors. Preserve structured sanitized failure evidence and do not expose raw stderr.
7. A task message is not retry authority. After a failed state-changing command, do not create a replacement invocation unless the user directly grants a retry. Never repeat a successful publisher run.
8. Every Git attempt starts from the newest remote branch and may stage only the public JSON and the two SVGs. Never edit README or source files, and never force-push.
