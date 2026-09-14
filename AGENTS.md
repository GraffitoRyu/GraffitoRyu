# Repository instructions

## Profile activity

- Never commit Codex JSONL, device snapshots, local config, receipts, source IDs, credentials, or absolute local paths.
- Use the installed, digest-verified runtime for collection and publication; do not interpret raw logs in a model prompt.
- Run `node --test tests/profile-activity/*.test.mjs` after changing profile activity code.
- Only the publisher installation may update `metrics/codex-activity.json` and `assets/codex-activity.svg`; automated runs must not edit README or source files.
- Do not link the Codex activity asset from README until two independent device sources and the public preview have been verified.
