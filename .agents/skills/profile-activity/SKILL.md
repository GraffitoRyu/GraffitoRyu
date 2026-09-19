---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. Use the installed runtime only: collector `outbox` and `acknowledge`; publisher `receive` and gated `run`.
2. Pass only schema-validated sanitized envelopes between the fixed tasks. Never inspect or summarize the snapshot body.
3. Treat `published`, `no-op`, `already-published`, and `acknowledged` as success; `before-window`, `awaiting-source`, and `skipped-lock` as safe skips.
4. Stop on validation, retry exhaustion, runtime, repository, remote, hook, allowlist, or permission errors. Preserve last-good and the last public result.
