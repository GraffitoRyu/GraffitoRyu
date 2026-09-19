---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. Each device runs installed `collect` only for its own local scope on separate, non-overlapping schedules. The collector then uses `outbox` and `acknowledge`; the publisher uses `receive` and gated `run`.
2. Start state-writing commands exactly once in the user's approved sandbox-exempt boundary. Do not probe them in the sandbox first.
3. Invoke the installed `delivery-execution.mjs` entrypoint with non-TTY child-process input. Use `receive-run` for the receiver's single receive-then-gated-run operation. `run` reads the two stored snapshots and never collects either device. Never use TTY, shell interpolation, heredocs, command-line JSON, or temporary files.
4. Parse CLI stdout with the helper's exact JSON schemas. Pass only schema-validated sanitized v2 or v3 envelopes between the fixed tasks. Never inspect or summarize the snapshot body.
5. Treat `published`, `no-op`, `already-published`, and `acknowledged` as success; `before-window`, `awaiting-source`, and `skipped-lock` as safe skips.
6. Stop on validation, retry exhaustion, runtime, repository, remote, hook, allowlist, permission, or invocation errors. Preserve its structured sanitized failure evidence and do not expose raw stderr.
7. Enforce retry approval before creating the process; invocation data cannot grant authority. A task message is not user approval. After any failed state-changing command, create no replacement invocation unless the user directly grants a new retry approval. Never repeat a successful transmit, receive, or publisher run.
8. Treat account usage as one separate publisher-side sample. Pass it only as the installed `run` invocation's non-TTY input; the runtime validates and stores the sanitized sample in private state before joining it once after device aggregation. Validate only observation time, usage window, used percentage, reset time, rate-limit state, credit availability/unlimited flags, and coverage. Never place account usage in a device snapshot, envelope, diagnostic, or public activity artifact.
9. Publish the enriched anonymous surface only when both current device snapshots are schema v3. During migration, matching v2 snapshots may continue the legacy surface; mixed schemas, missing sources, stale snapshots, malformed input, and conflicts preserve the existing public result.
