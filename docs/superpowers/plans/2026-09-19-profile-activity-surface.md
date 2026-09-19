# Anonymous 30-Day Profile Activity Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-preserving private snapshot schema v3 and publish an anonymous enriched 30-day activity surface only after two current v3 device snapshots are available.

**Architecture:** Keep collection device-local and reduce structured records to fixed counters before persistence. Extend the existing strict contracts, processing-only aggregator, envelope, publication gate, and static renderer without changing runtime installation or operating state. Keep account usage in a separate exact private contract and combine it only in an in-memory processing result, never in the public activity object.

**Tech Stack:** Node.js ESM, Node standard library, `node:test`

**Spec:** `docs/superpowers/specs/2026-09-19-profile-activity-surface-design.md`

## Global Constraints

- Preserve the collector -> private snapshot -> relay -> processing-only merge -> public schema -> static renderer boundary.
- Snapshot v3 contains exactly the latest 30 contiguous KST dates; v2 remains readable.
- Persist no prompt, response, arguments, session/source/device/account identity, plugin/skill/model name, path, credential, balance, plan, reset-credit metadata, raw native response, or raw JSONL.
- Do not infer skill, mode, or reasoning values from prompt text, paths, commands, or arguments; absent explicit structured events remain `null`.
- Add no dependency, framework, package-manager operation, installation, automation change, delivery operation, publication, generated artifact update, README change, or push.
- Preserve the last public result for missing, stale, mixed-schema, malformed, and conflicting inputs.

## Review Focus

- A malformed optional structured event must make only its optional metric unavailable while preserving core activity counts; Task 1 tests this.
- A session first seen before the 30-day window must not count as a new chat inside the window; Task 1 tests this.
- An explicit plugin identity or tool name must be reduced to fixed counters and never survive serialized cache, snapshot, envelope, diagnostics, or public output; Tasks 1 and 3 test this.
- One unavailable optional metric on either source must make the merged metric `null`, not zero or a partial total; Task 2 tests this.
- A stale v3 pair or mixed v2/v3 pair must not pass the publication gate; Task 3 tests this.

---

### Task 1: Private v3 contract and device-local collection

**Files:**
- Modify: `scripts/profile-activity/contract.mjs`
- Modify: `scripts/profile-activity/collect.mjs`
- Modify: `scripts/profile-activity/cli.mjs`
- Modify: `tests/profile-activity/fixtures.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: existing mechanical JSONL scan and v1/v2 `parsePrivateSnapshot(value)` behavior.
- Produces: v3 `parsePrivateSnapshot(value)`, 30-day `collectLogRoots(...).days`, and v3 collector snapshots with anonymous daily counters only.

- [ ] **Step 1: Write failing v3 contract tests**

Add literal v3 fixtures and tests that require exactly 30 contiguous KST dates, exact daily keys, fixed reasoning keys, denominator equality, non-negative safe integers, and rejection of extra or identifying keys.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='v3 schema' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because schema v3 is unsupported.

- [ ] **Step 3: Implement the minimum strict v3 parser**

Add schema-specific exact daily keys for `newChats`, `pluginCalls`, `browserCalls`, `computerUseCalls`, `otherToolCalls`, `skillUses`, `fastTurns`, `modeTurns`, `reasoningTurns`, and fixed `reasoning` categories. Require `window.from + 29 days === window.to` only for v3 and retain v1/v2 parsing unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test --test-name-pattern='v3 schema' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing collector privacy and structured-event tests**

Add synthetic records for two logical sessions, calls with explicit plugin identity, web/browser, computer-use, and other tools, plus explicit skill-use, Fast mode, and reasoning events. Assert unique/new chats without session identifiers; fixed counters without names; `null` optional metrics when events are absent; and optional-only unavailability for malformed structured events.

- [ ] **Step 6: Run the collector tests and verify RED**

Run: `node --test --test-name-pattern='v3 collector' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because v3 counters and optional event handling do not exist.

- [ ] **Step 7: Implement anonymous collection and v3 CLI snapshots**

Extend cache events only with fixed categories and numeric facts, discard input identities after classification, calculate new chats from in-memory session sets, and use `publicDays` to create exactly 30-day schema v3 snapshots. Keep `run` processing-only.

- [ ] **Step 8: Run focused and full tests**

Run: `node --test tests/profile-activity/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```sh
git add scripts/profile-activity/contract.mjs scripts/profile-activity/collect.mjs scripts/profile-activity/cli.mjs tests/profile-activity/fixtures.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m "Profile Activity v3 수집 계약 추가"
```

### Task 2: Two-source v3 aggregation and public surface

**Files:**
- Modify: `scripts/profile-activity/contract.mjs`
- Modify: `scripts/profile-activity/aggregate.mjs`
- Modify: `scripts/profile-activity/render.mjs`
- Modify: `tests/profile-activity/fixtures.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: two parsed v3 snapshots from Task 1.
- Produces: public schema v3 with anonymous daily/summary counters, weighted Fast/reasoning percentages, streaks, and deterministic static SVG rendering.

- [ ] **Step 1: Write failing merge tests**

Add two literal v3 snapshots with unequal denominators. Assert additive sums only when both values are known, maximum token/span values, numerator/denominator weighted percentages, fixed reasoning percentages, unique/new chat totals, streaks, and `null` propagation from either source.

- [ ] **Step 2: Run merge tests and verify RED**

Run: `node --test --test-name-pattern='v3 aggregate' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because the aggregator emits only public schema v1/v2.

- [ ] **Step 3: Implement public v3 contract and aggregation**

Extend `parsePublicActivity` with exact schema v3 keys. Aggregate additive counters by sum, maxima by maximum, optional metrics only with two known sources, and percentages from summed numerators and denominators. Preserve v1/v2 behavior.

- [ ] **Step 4: Run merge tests and verify GREEN**

Run: `node --test --test-name-pattern='v3 aggregate' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing renderer privacy tests**

Assert deterministic schema v3 SVG output includes the anonymous enriched metrics and fixed reasoning labels, but contains no source split, plugin/skill identity, canary, active content, or external reference.

- [ ] **Step 6: Run renderer tests and verify RED**

Run: `node --test --test-name-pattern='v3 renderer' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because schema v3 rendering does not exist.

- [ ] **Step 7: Implement the minimum static v3 renderer**

Reuse existing escaping and number formatting, render only fixed labels and aggregate values, and keep v1/v2 rendering unchanged.

- [ ] **Step 8: Run full tests**

Run: `node --test tests/profile-activity/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```sh
git add scripts/profile-activity/contract.mjs scripts/profile-activity/aggregate.mjs scripts/profile-activity/render.mjs tests/profile-activity/fixtures.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m "두 장비 익명 activity surface 병합 추가"
```

### Task 3: Account sanitization, v3 relay gate, preservation, and documentation

**Files:**
- Create: `scripts/profile-activity/account-usage.mjs`
- Modify: `scripts/profile-activity/relay.mjs`
- Modify: `scripts/profile-activity/publication-gate.mjs`
- Modify: `scripts/profile-activity/cli.mjs`
- Modify: `.agents/skills/profile-activity/SKILL.md`
- Modify: `docs/profile-activity.md`
- Modify: `tests/profile-activity/profile-activity.test.mjs`
- Add: `docs/superpowers/plans/2026-09-19-profile-activity-surface.md`

**Interfaces:**
- Consumes: strict v2/v3 private snapshots, existing delivery state, and one exact private account sample.
- Produces: version-matched v2/v3 envelopes, a v3-only enriched publication gate, and `processActivitySurface(snapshots, options, accountUsage)` returning `{ activity, accountUsage }` without placing account usage in public output.

- [ ] **Step 1: Write failing account sanitizer tests**

Test exact accepted keys for observation time, window duration, used percentage, reset time, rate-limit state, credit available/unlimited flags, and coverage. Reject account ID, balance, plan, reset-credit metadata, raw response, extra keys, invalid percentages, and inconsistent credit flags. Assert pre-first-sample history is represented as `null` by absence of a sample.

- [ ] **Step 2: Run sanitizer tests and verify RED**

Run: `node --test --test-name-pattern='account usage' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because `account-usage.mjs` does not exist.

- [ ] **Step 3: Implement exact account sanitization and one-time processing join**

Create `parseAccountUsage(value)` and `processActivitySurface(snapshots, options, accountUsage = null)`. Parse the account sample once after `aggregateSnapshots`; return it beside, never inside, the public activity object.

- [ ] **Step 4: Run sanitizer tests and verify GREEN**

Run: `node --test --test-name-pattern='account usage' tests/profile-activity/profile-activity.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing relay/gate/preservation tests**

Test v2 and v3 envelopes, rejection of envelope schema mismatch, v2-only legacy publication, v3-only enriched publication, mixed-schema/missing/stale/conflict/malformed preservation, processing-only merge, and canary absence across snapshot/envelope/diagnostic/public serialization.

- [ ] **Step 6: Run relay/gate tests and verify RED**

Run: `node --test --test-name-pattern='v3 (envelope|publication|preservation|processing)' tests/profile-activity/profile-activity.test.mjs`

Expected: FAIL because relay and gate accept only v2.

- [ ] **Step 7: Implement version-matched relay and publication decisions**

Use version-specific envelope schema labels, require both selected sources to share schema v2 or v3, reject stale/future/current-window failures before publication, and keep `run` limited to stored snapshots.

- [ ] **Step 8: Update operator-facing source documentation**

Document schema v3 privacy, 30-day metrics, separate account scope, v2 migration behavior, processing-only merge, and the rule that installation and operational validation remain separate approvals.

- [ ] **Step 9: Run required verification**

Run: `node --test tests/profile-activity/*.test.mjs`

Expected: all tests PASS.

Run: `git diff --check`

Expected: exit 0 with no output.

Run: `git status --short`

Expected: no changes to `README.md`, `metrics/codex-activity.json`, or `assets/codex-activity.svg`.

- [ ] **Step 10: Commit**

```sh
git add scripts/profile-activity/account-usage.mjs scripts/profile-activity/relay.mjs scripts/profile-activity/publication-gate.mjs scripts/profile-activity/cli.mjs .agents/skills/profile-activity/SKILL.md docs/profile-activity.md docs/superpowers/plans/2026-09-19-profile-activity-surface.md tests/profile-activity/profile-activity.test.mjs
git commit -m "Profile Activity v3 게시 보호 조건 반영"
```
