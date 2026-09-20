# Repository instructions

## Profile activity

- Never commit private config, receipts, credentials, raw App Server responses, or absolute local paths.
- Use the installed, digest-verified runtime for App Server collection and publication; do not interpret raw responses in a model prompt.
- Run `node --test tests/profile-activity/*.test.mjs` after changing profile activity code.
- The installed publisher may update only `metrics/codex-activity.json`, `assets/codex-activity.svg`, and `assets/codex-activity-ko.svg`. Automated runs must not edit README or source files.
- Publish only a complete, schema-validated 30-day account token response. Preserve the existing public files when collection or validation fails.
