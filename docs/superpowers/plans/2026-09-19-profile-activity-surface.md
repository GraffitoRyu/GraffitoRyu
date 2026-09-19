# Direct Device Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MacBook and Mac mini publish separate anonymous 30-day collection files directly to the repository and merge them only when rendering the public activity surface.

**Architecture:** Each installed collector keeps raw parsing and private cache local and writes only its fixed sanitized repository collection. Mac mini runs later as the sole renderer, merging the latest two collection files into the existing public JSON/SVG pair. The active workflow has no envelope, receive, acknowledgement, or cross-device payload; Git serialization and non-overlapping schedules coordinate the two independent publishers.

**Tech Stack:** Node.js ESM, Node standard library, `node:test`, Git

**Spec:** `docs/superpowers/specs/2026-09-19-profile-activity-surface-design.md`

## Global Constraints

- MacBook writes only `metrics/codex-activity-macbook.json`; Mac mini writes only `metrics/codex-activity-macmini.json`.
- Collection bodies contain schema v3 anonymous aggregate fields only; the filename binds the slot.
- Only the Mac mini visualization step reads both repository collection files; neither device reads the other device's logs or private state.
- The merged output remains `metrics/codex-activity.json` and `assets/codex-activity.svg`.
- Missing, stale, malformed, or mixed-schema collections preserve the previous merged output.
- Raw JSONL is parsed only by the installed runtime and never enters model output, repository files, or diagnostics.
- No new dependency, framework, database, shared folder, force push, or direct push to `origin/main`.
- README is not changed.

## Review Focus

- A device must be unable to write the other slot, even with a forged command argument; Task 1 tests fixed config-to-path binding.
- A valid current collection must be committed even when the peer collection is unavailable, while merged output remains byte-identical; Task 2 tests this split outcome.
- A non-fast-forward retry must re-read both remote collections and rerender without recollecting; Task 2 tests call counts and final bytes.
- Collection files must reject source/device IDs, digests, names, paths, and extra keys; Task 1 tests private canaries and exact keys.
- Account usage must be sampled by the designated final renderer only and never enter either device collection; Task 2 tests collection bytes and processing inputs.

---

### Task 1: Repository collection contract and fixed slots

**Files:**
- Create: `scripts/profile-activity/collection.mjs`
- Modify: `scripts/profile-activity/config.mjs`
- Modify: `scripts/profile-activity/contract.mjs`
- Modify: `tests/profile-activity/fixtures.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: `parsePrivateSnapshot(value)` schema v3 output and installed config role/slot.
- Produces: `parseRepositoryCollection(value)`, `collectionPath(slot)`, and `createRepositoryCollection(snapshot)`.

- [ ] **Step 1: Write failing exact-contract tests**

Add tests constructing a schema v3 snapshot and asserting:

```js
assert.deepEqual(createRepositoryCollection(snapshot), parseRepositoryCollection(snapshot));
assert.equal(collectionPath('macbook'), 'metrics/codex-activity-macbook.json');
assert.equal(collectionPath('macmini'), 'metrics/codex-activity-macmini.json');
assert.throws(() => collectionPath('../peer'), /invalid collection slot/);
```

Reject bodies containing `sourceId`, `deviceId`, `digest`, plugin/skill names, paths, or any extra key.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='repository collection' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because `collection.mjs` and slot validation do not exist.

- [ ] **Step 3: Implement the minimum contract**

Implement fixed `macbook` and `macmini` path mapping, reuse `parsePrivateSnapshot` for the anonymous schema v3 body, and extend installed config with one exact `collectionSlot` enum. Do not serialize the slot into the collection body.

- [ ] **Step 4: Verify GREEN and regression suite**

Run: `node --test --test-name-pattern='repository collection' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS.

Run: `node --test tests/profile-activity/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```sh
git add scripts/profile-activity/collection.mjs scripts/profile-activity/config.mjs scripts/profile-activity/contract.mjs tests/profile-activity/fixtures.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m "장비별 익명 collection 계약 추가"
```

### Task 2: Direct repository publication and visualization-only merge

**Files:**
- Modify: `scripts/profile-activity/cli.mjs`
- Modify: `scripts/profile-activity/publish.mjs`
- Modify: `scripts/profile-activity/publication-gate.mjs`
- Modify: `scripts/profile-activity/aggregate.mjs`
- Modify: `scripts/profile-activity/render.mjs`
- Delete: `scripts/profile-activity/relay.mjs`
- Modify: `scripts/profile-activity/delivery-execution.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: local schema v3 snapshot, fixed collection slot, latest repository worktree, optional exact account sample.
- Produces: `publishCollection(config, collection, options)` that stages the local slot and conditionally stages merged JSON/SVG.

- [ ] **Step 1: Write failing direct-publication tests**

Add synthetic Git repository tests proving:

```js
assert.deepEqual(stagedPaths, [ownCollectionPath, 'assets/codex-activity.svg', 'metrics/codex-activity.json'].sort());
assert.equal(collectCalls, 1);
assert.equal(peerCollectionWrites, 0);
```

When the peer is missing/stale/malformed, assert only the own collection is staged and existing merged output bytes stay unchanged. On a synthetic non-fast-forward, assert the retry fetches latest collections, rerenders, and does not invoke collection again.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='direct collection publication' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because publication accepts only the old generated-file pair and reads private/transport snapshots.

- [ ] **Step 3: Implement direct publication**

Add one installed command that collects the local scope once and publishes its own repository collection. For MacBook, the allowlist is only its collection. For Mac mini, the allowlist is its collection plus the existing merged pair; it reads both repository collection files and generates merged JSON/SVG only when both validate as current v3. Reuse the existing bounded non-fast-forward retry, but rerender from refreshed repository bytes without recollecting.

- [ ] **Step 4: Remove relay from the active CLI path**

Remove `outbox`, `receive`, `acknowledge`, envelope parsing, and `receive-run` from the installed runtime and active CLI. Delete `relay.mjs`; no active command may use delivery state as publication input.

- [ ] **Step 5: Verify GREEN and privacy**

Run: `node --test --test-name-pattern='direct collection publication' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS.

Run: `node --test --test-name-pattern='canary|privacy|renderer|aggregate' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS with no canary in collection or merged bytes.

- [ ] **Step 6: Commit**

```sh
git add scripts/profile-activity/cli.mjs scripts/profile-activity/publish.mjs scripts/profile-activity/publication-gate.mjs scripts/profile-activity/aggregate.mjs scripts/profile-activity/render.mjs scripts/profile-activity/delivery-execution.mjs scripts/profile-activity/relay.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m "장비별 collection 직접 게시 전환"
```

### Task 3: Installation, schedules, documentation, and rollout validation

**Files:**
- Modify: `scripts/profile-activity/install-local.mjs`
- Modify: `scripts/profile-activity/plist.mjs`
- Modify: `.agents/skills/profile-activity/SKILL.md`
- Modify: `docs/profile-activity.md`
- Modify: `tests/profile-activity/profile-activity.test.mjs`
- Modify: `docs/superpowers/plans/2026-09-19-profile-activity-surface.md`

**Interfaces:**
- Consumes: Task 2 direct publication command and per-device `collectionSlot` config.
- Produces: receipt-pinned installed entrypoint and non-overlapping device schedules with no relay task dependency.

- [ ] **Step 1: Write failing installer and schedule tests**

Assert generated installed config binds exactly one slot, collector plist invokes the direct publication command, no program arguments name `outbox`, `receive`, or `acknowledge`, and the two approved schedules do not overlap.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='direct collection install|non-overlapping direct schedules' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because installation still provisions the relay-era commands and schedule.

- [ ] **Step 3: Implement installation and documentation updates**

Generate the direct publication entrypoint from installed config, retain digest verification and exact allowlists, document the two collection files and visualization-only merge, and remove relay/ACK instructions from the active operator workflow.

- [ ] **Step 4: Run full verification**

Run: `node --test tests/profile-activity/*.test.mjs`

Expected: all tests PASS.

Run: `git diff --check`

Expected: exit 0 with no output.

Run: `git diff --name-only HEAD -- README.md`

Expected: no output.

- [ ] **Step 5: Commit and review**

```sh
git add scripts/profile-activity/install-local.mjs scripts/profile-activity/plist.mjs .agents/skills/profile-activity/SKILL.md docs/profile-activity.md docs/superpowers/plans/2026-09-19-profile-activity-surface.md tests/profile-activity/profile-activity.test.mjs
git commit -m "장비별 direct collection 운영 경로 반영"
```

Run a fresh whole-branch review against the spec. Fix every Critical or Important finding with RED-to-GREEN coverage, then rerun the full suite.

### Task 4: Push and deploy

**Files:**
- No source files; operates only on verified Git refs, installed runtime, private config, owned schedules, and generated publication files.

**Interfaces:**
- Consumes: reviewed clean branch HEAD and two existing private device configs.
- Produces: remote feature branch, digest-verified runtimes on both devices, non-overlapping direct schedules, and one verified direct update per device.

- [ ] **Step 1: Push the reviewed feature branch**

Verify the upstream is `origin/fix/profile-activity-delivery-ack`, then push `HEAD:refs/heads/fix/profile-activity-delivery-ack`. Never push this branch to `origin/main` and never force-push.

- [ ] **Step 2: Install the exact approved commit on each device**

Use each device's existing private config, adding only its fixed `collectionSlot`. Install through `install-local.mjs --apply` from the exact full commit and verify the installation receipt and runtime manifest digest before execution.

- [ ] **Step 3: Apply non-overlapping schedules**

Preserve existing schedule times when already distinct. If they overlap, move only the MacBook direct publication one existing interval earlier than Mac mini; verify both owned jobs and do not modify unrelated LaunchAgents or automations.

- [ ] **Step 4: Run one direct update per device in schedule order**

Run MacBook once, verify only its collection path changed, then run Mac mini once, verify only its collection plus the merged pair changed. Do not run relay, outbox, receive, or acknowledgement commands.

- [ ] **Step 5: Verify deployment**

Verify both collection files are current valid schema v3 anonymous aggregates, merged JSON/SVG parse and render deterministically, privacy canaries and forbidden keys are absent, README is unchanged, installed manifests match, schedules are non-overlapping, and the remote repository contains the expected publication commits.
