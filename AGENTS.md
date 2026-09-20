# Repository instructions

## Profile activity

- Never commit Codex JSONL, private device snapshots, local config, receipts, source IDs, credentials, or absolute local paths. The two schema-validated anonymous collection files are the only device-scoped public data allowed.
- Use the installed, digest-verified runtime for collection and publication; do not interpret raw logs in a model prompt.
- Run `node --test tests/profile-activity/*.test.mjs` after changing profile activity code.
- Each installed device publisher may update only its owned collection file and may replace `metrics/codex-activity.json`, `assets/codex-activity.svg`, and `assets/codex-activity-ko.svg` only after both public collections validate for the current KST window. Automated runs must not edit README, the peer collection, or source files.
- Do not link the Codex activity asset from README until two independent device sources and the public preview have been verified.
