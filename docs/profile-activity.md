# Codex account activity

The dashboard is generated from the official Codex App Server `account/usage/read` response. It publishes only five validated account token summaries and an exact 30-day daily token series:

- lifetime tokens
- peak daily tokens
- longest running turn
- current streak
- longest streak

The runtime discards the raw response after reducing it to the strict public schema. It never publishes account details, credentials, paths, tasks, threads, prompts, responses, plugin or skill names, local logs, or device identifiers.

## Runtime

The source runtime is installed as a content-addressed copy from an exact Git commit. Every execution verifies the runtime manifest, installed config, installation receipt, repository remote, Git hooks, and publication allowlist before changing public files.

```sh
node scripts/profile-activity/install-local.mjs --plan
node scripts/profile-activity/install-local.mjs --apply --config /private/path/config.json --source-commit <full-commit-sha>
node /private/runtime/execution.mjs run --receipt /private/state/installation-receipt.json
```

Private paths above are examples only and must not be committed. The installed config and receipt remain outside the repository.

## Schedule and publication

The Mac mini owns one daily run at **00:30 UTC (09:30 KST)**. The scheduler invokes the receipt-pinned installed runtime exactly once. The runtime queries the App Server, requires a complete schema-valid 30-day response, renders both language variants, and publishes only:

- `metrics/codex-activity.json`
- `assets/codex-activity.svg`
- `assets/codex-activity-ko.svg`

Each publication attempt fetches the newest `origin/main`, uses an isolated candidate worktree, verifies hooks and staged paths, and never force-pushes. Collection or validation failure leaves the existing public files unchanged. `published` and `no-op` are success, while `skipped-lock` is a safe concurrent-run skip.

## Recovery

Do not retry a failed state-changing run without direct user approval. Pause the scheduler before replacing or removing the installed runtime. Never delete credentials or source account data as part of recovery.
