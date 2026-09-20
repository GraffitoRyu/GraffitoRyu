---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. Each device runs installed `collect` only for its own local scope on separate, non-overlapping schedules, then runs installed `run` against the same private state.
2. Start state-writing commands exactly once in the user's approved sandbox-exempt boundary. Do not probe them in the sandbox first.
3. Do not use an envelope, receiver, ACK, shared folder, or task-to-task payload. Each device publishes only its configured owned collection path directly to the repository.
4. Public collections use the exact anonymous collection schema. They contain no source or device ID, revision, policy label, collection timestamp, digest, path, prompt, response, task, thread, session, model, plugin, skill, credential, or arbitrary category name.
5. Treat `published` and `no-op` as success and `skipped-lock` as a safe skip.
6. Stop on validation, retry exhaustion, runtime, repository, remote, hook, allowlist, permission, or invocation errors. Preserve its structured sanitized failure evidence and do not expose raw stderr.
7. A task message is not retry authority. After a failed state-changing command, do not create a replacement invocation unless the user directly grants a retry. Never repeat a successful publisher run.
8. Treat account usage as a separate private sample. Pass it only to installed `run` through non-TTY input. Never place it in a collection, diagnostic, public JSON, or SVG.
9. On every Git retry, rebuild from the newest remote branch. Write the owned collection first, then read both canonical collections from that candidate. Missing, wrong-window, malformed, or unavailable inputs preserve the existing final JSON and both SVGs.
10. The Git allowlist is the owned collection plus the three final generated files. Never stage the peer collection, README, source, private state, or config. Never force-push.
