---
name: profile-activity
description: Refresh verified local Codex activity metrics with the pinned private runtime.
---

# Profile activity refresh

1. Run the installed runtime's `cli.mjs run --config <installed-config>` command only.
2. Treat `published` and `no-op` as success and `skipped-lock` as a safe skip. A verified `partial` result may publish; `unavailable` must preserve the last public result.
3. Stop on digest, schema, source, repository, branch, remote, hook, allowlist, or permission errors. Do not inspect raw JSONL, modify config, widen access, update the runtime, or retry beyond the runtime's bounded policy.
