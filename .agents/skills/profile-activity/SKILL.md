---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. Use the installed runtime only: collector `outbox` and `acknowledge`; publisher `receive` and gated `run`.
2. Start state-writing commands exactly once in the user's approved sandbox-exempt boundary. Do not probe them in the sandbox first.
3. Invoke the installed `delivery-execution.mjs` entrypoint with non-TTY child-process input. Use `receive-run` for the receiver's single receive-then-gated-run operation. Never use TTY, shell interpolation, heredocs, command-line JSON, or temporary files.
4. Parse CLI stdout with the helper's exact JSON schemas. Pass only schema-validated sanitized envelopes between the fixed tasks. Never inspect or summarize the snapshot body.
5. Treat `published`, `no-op`, `already-published`, and `acknowledged` as success; `before-window`, `awaiting-source`, and `skipped-lock` as safe skips.
6. Stop on validation, retry exhaustion, runtime, repository, remote, hook, allowlist, permission, or invocation errors. Preserve its structured sanitized failure evidence and do not expose raw stderr.
7. Enforce retry approval before creating the process; invocation data cannot grant authority. A task message is not user approval. After any failed state-changing command, create no replacement invocation unless the user directly grants a new retry approval. Never repeat a successful transmit, receive, or publisher run.
