# Profile Activity Direct Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the MacBook's sanitized schema v2 activity snapshot through two fixed Codex tasks and publish once after 08:00 KST only when both current-day snapshots are valid.

**Architecture:** Installed runtime code owns envelope validation, sender retry state, receiver last-good replacement, daily readiness, and publication receipts. A fixed MacBook heartbeat relays runtime-produced envelopes to a fixed Mac mini receiver; the receiver and its 08:00 heartbeat invoke the same idempotent publisher gate.

**Tech Stack:** Node.js ESM and standard library, `node:test`, macOS `launchd`, Codex Desktop heartbeat automations, Git.

**Spec:** `docs/superpowers/specs/2026-09-19-profile-activity-direct-communication-design.md`

## Global Constraints

- Raw Codex JSONL, prompts, responses, tool arguments, credentials, local paths, device identifiers, and source identifiers never enter a model prompt or public output.
- The sanitized private snapshot may pass through the two fixed private Codex task histories.
- Collection and publication use only installed, digest-verified runtime code.
- Only the publisher installation may change `metrics/codex-activity.json` and `assets/codex-activity.svg`.
- Missing current-day MacBook data skips publication and preserves the previous public result.
- Publication occurs at most once per KST date.
- No iCloud, custom server, database, queue, third-party dependency, sleep prevention, or per-run task creation.
- Repository tests remain `node --test tests/profile-activity/*.test.mjs`.

## File Structure

- Create `scripts/profile-activity/relay.mjs`: snapshot envelope parsing, digest verification, sender attempt state, acknowledgement state, and receiver last-good replacement.
- Create `scripts/profile-activity/publication-gate.mjs`: KST readiness decision and successful-publication receipt handling.
- Modify `scripts/profile-activity/cli.mjs`: add installed `outbox`, `acknowledge`, and `receive` commands and route both scheduled and receive-triggered publication through one gate.
- Modify `scripts/profile-activity/install-local.mjs`: change the owned collector interval from 30 minutes to 15 minutes and report the exact candidate schedule.
- Modify `tests/profile-activity/profile-activity.test.mjs`: add contract, state-machine, CLI, scheduler, and privacy checks.
- Modify `.agents/skills/profile-activity/SKILL.md`: document installed sender, receiver, and gated publisher commands without private values.
- Modify `docs/profile-activity.md`: document the direct Codex relay, once-daily gate, skip behavior, and recovery order.
- Private only, never committed: installed configs, runtime receipts, task IDs, source IDs, envelope bodies, heartbeat definitions, and daily receipts.

## Review Focus

- A same-revision envelope with a different digest must be rejected without replacing last-good; pinned in Task 1.
- A sender restart must retain attempt count and stop after four unacknowledged sends; pinned in Task 2.
- KST date boundaries and exactly 08:00:00 must produce deterministic readiness; pinned in Task 3.
- A receive-triggered publish racing the 08:00 heartbeat must produce one publication; pinned in Task 4.
- Automation migration must leave two fixed heartbeat targets, no active legacy cron, and no extra task; pinned in Task 6.

---

### Task 1: Snapshot envelope and receiver contract

**Files:**
- Create: `scripts/profile-activity/relay.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: `parsePrivateSnapshot(value)`, `stableJson(value)`, `snapshotDigest(snapshot)`, and `atomicWrite(file, value, scope)`.
- Produces: `createEnvelope(snapshot)`, `parseEnvelope(value)`, and `receiveEnvelope({ envelope, expectedSourceId, lastGoodFile, stateScope })`.

- [ ] **Step 1: Write failing envelope tests**

Add imports and tests that establish the external contract:

```js
import { createEnvelope, parseEnvelope, receiveEnvelope } from '../../scripts/profile-activity/relay.mjs';

test('T50 envelope digest is metadata and verifies canonical snapshot bytes', () => {
  const snapshot = insightSnapshot();
  const envelope = createEnvelope(snapshot);
  assert.deepEqual(Object.keys(envelope).sort(), ['digest', 'revision', 'schema', 'snapshot']);
  assert.equal(envelope.schema, 'PROFILE_ACTIVITY_SNAPSHOT_V2');
  assert.equal(envelope.revision, snapshot.revision);
  assert.deepEqual(parseEnvelope(envelope).snapshot, snapshot);
  assert.throws(() => parseEnvelope({ ...envelope, digest: '0'.repeat(64) }), /digest mismatch/);
});

test('T51 receiver is idempotent and rejects rollback and conflict', async () => {
  const root = await temp();
  const file = path.join(root, 'last-good.json');
  const first = createEnvelope(insightSnapshot({ revision: 2 }));
  assert.equal((await receiveEnvelope({ envelope: first, expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root })).status, 'received');
  assert.equal((await receiveEnvelope({ envelope: first, expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root })).status, 'acknowledged');
  await assert.rejects(receiveEnvelope({ envelope: createEnvelope(insightSnapshot({ revision: 1 })), expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root }), /rollback/);
  await assert.rejects(receiveEnvelope({ envelope: createEnvelope(insightSnapshot({ revision: 2, calls: 9 })), expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root }), /conflict/);
  assert.equal((await readSnapshot(file, root)).revision, 2);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```sh
node --test --test-name-pattern='T50|T51' tests/profile-activity/profile-activity.test.mjs
```

Expected: FAIL because `relay.mjs` does not exist.

- [ ] **Step 3: Implement the minimal envelope module**

First extend the existing `insightSnapshot` test helper with `revision = 1` and `collectedAt = '2026-09-13T09:00:00.000Z'`, then pass both values to `makeSnapshot({ sourceId, revision, sessions, calls, collectedAt })`. This keeps every new schema v2 fixture structurally valid.

Implement exact-key validation and canonical digest comparison. Keep digest outside the snapshot:

```js
import { readFile } from 'node:fs/promises';
import { parsePrivateSnapshot } from './contract.mjs';
import { atomicWrite, snapshotDigest } from './snapshot.mjs';

const SCHEMA = 'PROFILE_ACTIVITY_SNAPSHOT_V2';

export function createEnvelope(value) {
  const snapshot = parsePrivateSnapshot(value);
  if (snapshot.schemaVersion !== 2) throw new Error('schema v2 required');
  return { schema: SCHEMA, revision: snapshot.revision, digest: snapshotDigest(snapshot), snapshot };
}

export function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'digest,revision,schema,snapshot') throw new Error('invalid envelope keys');
  const snapshot = parsePrivateSnapshot(value.snapshot);
  if (value.schema !== SCHEMA || snapshot.schemaVersion !== 2 || value.revision !== snapshot.revision) throw new Error('invalid envelope identity');
  if (!/^[0-9a-f]{64}$/.test(value.digest) || value.digest !== snapshotDigest(snapshot)) throw new Error('digest mismatch');
  return { schema: SCHEMA, revision: snapshot.revision, digest: value.digest, snapshot };
}
```

Implement `receiveEnvelope` by reading any existing last-good with `readSnapshot`, rejecting lower revisions and same-revision digest conflicts, and calling `atomicWrite` only for a higher valid revision. Return only `{ status, revision, digest }`.

- [ ] **Step 4: Run the focused and full tests**

Run:

```sh
node --test --test-name-pattern='T50|T51' tests/profile-activity/profile-activity.test.mjs
node --test tests/profile-activity/*.test.mjs
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the receiver contract**

```sh
git add scripts/profile-activity/relay.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m 'snapshot 직접 수신 계약 추가'
```

### Task 2: Sender attempts and acknowledgement state

**Files:**
- Modify: `scripts/profile-activity/relay.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: `createEnvelope(snapshot)` from Task 1 and private JSON state loaded by the caller.
- Produces: `nextDelivery({ snapshot, state, date })` and `acceptAcknowledgement({ acknowledgement, state })`.

- [ ] **Step 1: Write failing retry-state tests**

```js
test('T52 sender retries one revision four times and stops until acknowledgement', () => {
  const snapshot = insightSnapshot({ revision: 7 });
  let state = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = nextDelivery({ snapshot, state, date: '2026-09-19' });
    assert.equal(result.status, 'send');
    assert.equal(result.state.attempts, attempt);
    state = result.state;
  }
  assert.equal(nextDelivery({ snapshot, state, date: '2026-09-19' }).status, 'retry-exhausted');
  const acknowledgement = { status: 'received', revision: 7, digest: createEnvelope(snapshot).digest };
  const accepted = acceptAcknowledgement({ acknowledgement, state });
  assert.equal(accepted.acknowledgedRevision, 7);
  assert.equal(nextDelivery({ snapshot, state: accepted, date: '2026-09-19' }).status, 'acknowledged');
});

test('T53 sender restart preserves the pending envelope and a new date resets it', () => {
  const oldSnapshot = insightSnapshot({ revision: 7 });
  const first = nextDelivery({ snapshot: oldSnapshot, state: null, date: '2026-09-19' });
  const restored = JSON.parse(stableJson(first.state));
  const nextSnapshot = insightSnapshot({ revision: 8 });
  const retry = nextDelivery({ snapshot: nextSnapshot, state: restored, date: '2026-09-19' });
  assert.deepEqual(retry.envelope, first.envelope);
  assert.equal(retry.state.attempts, 2);
  const nextDate = nextDelivery({ snapshot: nextSnapshot, state: restored, date: '2026-09-20' });
  assert.equal(nextDate.envelope.revision, 8);
  assert.equal(nextDate.state.attempts, 1);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

```sh
node --test --test-name-pattern='T52|T53' tests/profile-activity/profile-activity.test.mjs
```

Expected: FAIL because sender state functions are not exported.

- [ ] **Step 3: Implement immutable sender state transitions**

Use this state shape and no timestamps other than the KST date:

```js
{
  date: '2026-09-19',
  envelope: {
    schema: 'PROFILE_ACTIVITY_SNAPSHOT_V2',
    revision: 7,
    digest: '64-lowercase-hex',
    snapshot: {}
  },
  attempts: 1,
  acknowledgedRevision: null,
  acknowledgedDigest: null
}
```

`nextDelivery` validates the snapshot through `createEnvelope`, stores the first envelope for the date, and retries that exact stored envelope even if the collector creates a higher revision meanwhile. It resets state only for a new date, returns `retry-exhausted` after four sends, and returns `acknowledged` only when revision and digest both match. `acceptAcknowledgement` accepts only `received` or `acknowledged` status and an exact revision/digest match.

- [ ] **Step 4: Run focused and full tests**

```sh
node --test --test-name-pattern='T52|T53' tests/profile-activity/profile-activity.test.mjs
node --test tests/profile-activity/*.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit sender state**

```sh
git add scripts/profile-activity/relay.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m 'snapshot 전달 재시도 상태 추가'
```

### Task 3: Daily publication gate and receipt

**Files:**
- Create: `scripts/profile-activity/publication-gate.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: two parsed private snapshots, an ISO instant, and an optional private receipt.
- Produces: `publicationDecision({ snapshots, expectedSourceIds, now, receipt })` and `publicationReceipt({ date, result })`.

- [ ] **Step 1: Write failing KST gate tests**

```js
import { publicationDecision, publicationReceipt } from '../../scripts/profile-activity/publication-gate.mjs';

test('T54 publication gate waits before 08:00 and becomes ready at 08:00 KST', () => {
  const snapshots = [
    insightSnapshot({ collectedAt: '2026-09-12T22:00:00.000Z' }),
    insightSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-12T22:00:00.000Z' }),
  ];
  assert.equal(publicationDecision({ snapshots, expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-12T22:59:59Z', receipt: null }).status, 'before-window');
  assert.equal(publicationDecision({ snapshots, expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-12T23:00:00Z', receipt: null }).status, 'ready');
});

test('T55 publication gate skips stale input and same-date repeats', () => {
  const current = insightSnapshot({ collectedAt: '2026-09-13T04:00:00.000Z' });
  const legacy = makeSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' });
  assert.equal(publicationDecision({ snapshots: [current, legacy], expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00Z', receipt: null }).status, 'awaiting-source');
  const receipt = publicationReceipt({ date: '2026-09-13', result: { status: 'published', commit: 'a'.repeat(40) } });
  assert.equal(publicationDecision({ snapshots: [current, insightSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' })], expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00Z', receipt }).status, 'already-published');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```sh
node --test --test-name-pattern='T54|T55' tests/profile-activity/profile-activity.test.mjs
```

Expected: FAIL because `publication-gate.mjs` does not exist.

- [ ] **Step 3: Implement KST decision and strict receipt parsing**

Use `Intl.DateTimeFormat` with `Asia/Seoul` to derive `{ date, hour, minute, second }`. The decision must parse both snapshots, select registered sources, require schema v2 and `window.to === date`, reject future snapshots, and return exactly one of:

```js
{ status: 'before-window', date }
{ status: 'awaiting-source', date }
{ status: 'already-published', date }
{ status: 'ready', date, snapshots }
```

`publicationReceipt` accepts only `published` and `no-op` results and returns:

```js
{ schemaVersion: 1, date, status: result.status, commit: result.commit ?? null }
```

- [ ] **Step 4: Run focused and full tests**

```sh
node --test --test-name-pattern='T54|T55' tests/profile-activity/profile-activity.test.mjs
node --test tests/profile-activity/*.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the publication gate**

```sh
git add scripts/profile-activity/publication-gate.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m '당일 활동 게시 조건 추가'
```

### Task 4: Installed CLI relay and single publication path

**Files:**
- Modify: `scripts/profile-activity/cli.mjs`
- Modify: `scripts/profile-activity/publication-gate.mjs`
- Modify: `scripts/profile-activity/publish.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`

**Interfaces:**
- Consumes: Task 1-3 APIs, installed config, stdin for private envelopes or acknowledgements, and existing `publishGenerated`.
- Produces: installed commands `outbox`, `acknowledge`, `receive`, and gated `run`.

- [ ] **Step 1: Write failing installed CLI tests**

Build a digest-valid temporary runtime using the existing T41 installation helper pattern. Add these assertions:

```js
import { publishIfReady } from '../../scripts/profile-activity/publication-gate.mjs';

test('T56 installed outbox and acknowledge persist private sender state', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(insightSnapshot()));
  const first = JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout);
  assert.equal(first.status, 'send');
  assert.equal(first.envelope.schema, 'PROFILE_ACTIVITY_SNAPSHOT_V2');
  const acknowledged = JSON.parse((await runWithInput(process.execPath, [fixture.cli, 'acknowledge', '--config', fixture.config], stableJson({ status: 'received', revision: first.envelope.revision, digest: first.envelope.digest }))).stdout);
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout).status, 'acknowledged');
});

test('T57 receive-triggered and 08:00 gates publish at most once', async () => {
  const root = await temp();
  const snapshots = [
    insightSnapshot({ collectedAt: '2026-09-13T04:00:00.000Z' }),
    insightSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' }),
  ];
  let publishes = 0;
  const invoke = () => publishIfReady({
    config: { stateDir: root },
    snapshots,
    expectedSourceIds: [SOURCE_A, SOURCE_B],
    now: '2026-09-13T05:00:00.000Z',
    receiptFile: path.join(root, 'publication-receipt.json'),
    publish: async () => {
      publishes += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { status: 'published', commit: 'a'.repeat(40) };
    },
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(results.filter(({ status }) => status === 'published').length, 1);
  assert.ok(results.every(({ status }) => ['published', 'skipped-lock', 'already-published'].includes(status)));
  assert.equal(publishes, 1);
});
```

The test helpers use only temporary directories and synthetic Git remotes. They do not touch installed private state.

Add `runWithInput` beside the existing promisified `run` helper so stdin behavior is real rather than simulated through unsupported `execFile` options:

```js
function runWithInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}
```

- [ ] **Step 2: Run focused tests and verify failure**

```sh
node --test --test-name-pattern='T56|T57' tests/profile-activity/profile-activity.test.mjs
```

Expected: FAIL because the new commands are not accepted.

- [ ] **Step 3: Add installed commands and private stdin parsing**

Add `publishIfReady({ config, snapshots, expectedSourceIds, now, receiptFile, publish })` to `publication-gate.mjs`. It acquires `withPublisherLock(config.stateDir, ...)`, reads and validates the receipt inside the lock, calls `publicationDecision`, invokes the injected `publish` callback only for `ready`, and atomically writes the receipt before releasing the lock. Safe decisions return their status without calling `publish`.

Extend `argumentsFor` to accept `outbox`, `acknowledge`, and `receive`. Add a bounded stdin reader before JSON parsing:

```js
async function readPrivateInput() {
  const input = await readFile(0, 'utf8');
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('private input too large');
  return JSON.parse(input);
}
```

Command behavior:

- `outbox`: collector role only; read `snapshot.json` and `delivery-state.json`, call `nextDelivery`, atomically persist returned state, and output `{ status, envelope? }`.
- `acknowledge`: collector role only; read acknowledgement from stdin, call `acceptAcknowledgement`, atomically replace `delivery-state.json`, and output `{ status: 'acknowledged', revision, digest }`.
- `receive`: publisher role only; read envelope from stdin, locate the single configured transport source, call `receiveEnvelope`, and output only `{ status, revision, digest }`. The fixed receiver task invokes gated `run` after a successful acknowledgement when the current time is at or after 08:00 KST.
- `run`: collect the local snapshot, call `publicationDecision`, return `before-window`, `awaiting-source`, or `already-published` without Git access, and call `publishGenerated` only for `ready`.
- After `published` or `no-op`, atomically write `publication-receipt.json` before returning.

Keep `withPublisherLock` around the ready decision, publication, and receipt write so the receive-triggered `run` and 08:00 heartbeat cannot both publish. Export an unlocked publication helper from `publish.mjs`, retain `publishGenerated` as its locking wrapper for existing callers, and use the unlocked helper only inside the CLI's outer lock. Do not acquire two nested publisher locks.

- [ ] **Step 4: Run focused and full tests**

```sh
node --test --test-name-pattern='T56|T57' tests/profile-activity/profile-activity.test.mjs
node --test tests/profile-activity/*.test.mjs
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 5: Commit the installed CLI flow**

```sh
git add scripts/profile-activity/cli.mjs scripts/profile-activity/publication-gate.mjs scripts/profile-activity/publish.mjs tests/profile-activity/profile-activity.test.mjs
git commit -m 'Codex 활동 직접 전달 게시 흐름 연결'
```

### Task 5: Collector interval and operator contract

**Files:**
- Modify: `scripts/profile-activity/install-local.mjs`
- Modify: `tests/profile-activity/profile-activity.test.mjs`
- Modify: `.agents/skills/profile-activity/SKILL.md`
- Modify: `docs/profile-activity.md`

**Interfaces:**
- Consumes: installed commands from Task 4.
- Produces: 15-minute collector plist, concise automation command contract, and documented recovery order.

- [ ] **Step 1: Write a failing collector schedule test**

Export `collectorPlist` for direct testing and add:

```js
test('T58 collector plist runs at login and every 15 minutes without wake controls', async () => {
  const root = await temp();
  const plist = collectorPlist({ label: 'com.graffitoryu.profile-activity.collector', nodeBinary: process.execPath, cli: path.join(root, 'runtime', 'cli.mjs'), configFile: path.join(root, 'state', 'installed-config.json') });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.doesNotMatch(plist, /KeepAlive|NetworkState|PreventSystemSleep/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```sh
node --test --test-name-pattern='T58' tests/profile-activity/profile-activity.test.mjs
```

Expected: FAIL because `collectorPlist` is not exported and still uses 1800 seconds.

- [ ] **Step 3: Change only the owned interval and documentation**

Export `collectorPlist`, change `StartInterval` from `1800` to `900`, and change the plan output to `login and 15-minute interval candidate`.

Update the skill with only installed commands and result meanings:

```markdown
1. Use the installed runtime only: collector `outbox` and `acknowledge`; publisher `receive` and gated `run`.
2. Pass only schema-validated sanitized envelopes between the fixed tasks. Never inspect or summarize the snapshot body.
3. Treat `published`, `no-op`, `already-published`, and `acknowledged` as success; `before-window`, `awaiting-source`, and `skipped-lock` as safe skips.
4. Stop on validation, retry exhaustion, runtime, repository, remote, hook, allowlist, or permission errors. Preserve last-good and the last public result.
```

Document the 08:00/first-receive flow, four-attempt sender bound, daily receipt, fixed-task requirement, and pause-first rollback sequence in `docs/profile-activity.md`.

- [ ] **Step 4: Run tests and documentation checks**

```sh
node --test --test-name-pattern='T58' tests/profile-activity/profile-activity.test.mjs
node --test tests/profile-activity/*.test.mjs
git diff --check
rg -n 'TODO|TBD|/Users/|sourceId' .agents/skills/profile-activity/SKILL.md docs/profile-activity.md
```

Expected: tests PASS, `git diff --check` is silent, and the final `rg` command finds no private path, unresolved marker, or source identifier.

- [ ] **Step 5: Commit scheduler and operator docs**

```sh
git add scripts/profile-activity/install-local.mjs tests/profile-activity/profile-activity.test.mjs .agents/skills/profile-activity/SKILL.md docs/profile-activity.md
git commit -m '활동 수집·게시 운영 계약 반영'
```

### Task 6: Source acceptance and two-device rollout

**Files:**
- Verify: all repository changes from Tasks 1-5
- Private update: existing MacBook collector installation and fixed sender heartbeat
- Private update: existing Mac mini publisher installation and fixed receiver heartbeat
- Remove after acceptance: active legacy standalone sender and publisher cron definitions

**Interfaces:**
- Consumes: committed source, installed runtime commands, existing private configs, and existing fixed task identities resolved through Codex Desktop.
- Produces: one acknowledged schema v2 delivery, one successful publication, two fixed heartbeats, and no active legacy cron.

- [ ] **Step 1: Run final source verification**

```sh
node --test tests/profile-activity/*.test.mjs
git diff --check
git status --short --branch
```

Expected: all tests PASS, no whitespace errors, and only planned files are modified.

- [ ] **Step 2: Review the complete branch before publication**

Review:

```sh
git diff origin/main...HEAD -- scripts/profile-activity tests/profile-activity .agents/skills/profile-activity/SKILL.md docs/profile-activity.md
git log --oneline origin/main..HEAD
```

Reject the branch if it contains a private path, source ID, snapshot value, automation ID, credential, dependency, README edit, or generated metric edit.

- [ ] **Step 3: Push the approved source commits**

Run the repository upstream safety check, confirm `main` tracks `origin/main`, then:

```sh
git push origin main
git ls-remote origin main
```

Expected: remote `main` resolves to the reviewed source commit.

- [ ] **Step 4: Verify private installation prerequisites before mutation**

On each host, read the existing installed config, receipt, runtime manifest, scheduler definition, and private source config without printing their values. Stop before removal unless the private source config needed for reinstall already exists and its role, expected source count, repository target, and owned scheduler label match the current receipt.

Record only non-sensitive booleans and the approved source commit. Do not reconstruct missing private config from task history.

- [ ] **Step 5: Upgrade Mac mini runtime and test receive without publication**

Pause the existing publisher automation. Remove the old installed runtime with its verified installed config, reinstall from the approved full source commit using the pre-existing publisher source config, and run one `receive` command while the publisher automation remains paused.

For the real installation, send a valid current envelope while the publisher automation remains paused. Expected result: acknowledgement succeeds, last-good becomes schema v2, and public Git state does not change until the gated publisher command runs.

- [ ] **Step 6: Upgrade MacBook runtime and verify one manual relay**

Pause the existing sender automation and unload only the owned collector job. Remove the verified old collector installation, reinstall the approved full source commit from the pre-existing collector source config, and verify the owned job reports active with a 900-second interval.

Run installed `outbox` once, relay its exact envelope through the fixed sender and receiver tasks, pass the returned acknowledgement to installed `acknowledge`, and verify the next `outbox` returns `acknowledged`. Do not publish during this step.

- [ ] **Step 7: Perform one controlled end-to-end publication**

At or after 08:00 KST, run the installed publisher gate exactly once with both current-day schema v2 snapshots. Accept `published` or `no-op`; accept `skipped-lock` only when the competing fixed receiver turn returns `published` or `no-op`.

Verify:

```sh
git status --short --branch
git diff-tree --no-commit-id --name-only -r origin/main
git ls-remote origin main
```

Expected: worktree clean, the published commit changes exactly `assets/codex-activity.svg` and `metrics/codex-activity.json`, and remote `main` contains the commit.

- [ ] **Step 8: Replace legacy cron with fixed heartbeats**

Create or update one heartbeat attached to the existing fixed MacBook sender task at a 15-minute interval. Its prompt runs installed `outbox`, sends only a returned envelope to the fixed receiver, records a valid acknowledgement through installed `acknowledge`, stays quiet for `acknowledged`, and stops for `retry-exhausted` or validation failure.

Create or update one heartbeat attached to the existing fixed Mac mini receiver task for 08:00 KST daily. Its prompt runs installed gated `run` exactly once and treats `before-window`, `awaiting-source`, `already-published`, and `skipped-lock` as safe non-publication results.

After both heartbeats are active and one manual relay has succeeded, pause and remove the old standalone sender and publisher cron definitions. Preserve their private memory until the first scheduled success; then keep only the concise non-sensitive checkpoint.

- [ ] **Step 9: Verify no task proliferation and recovery controls**

Use Codex Desktop task and automation inspection to confirm:

- both heartbeats target the two pre-existing fixed tasks;
- one heartbeat cycle does not create another task;
- no legacy cron remains active;
- MacBook sleep does not generate failures;
- a missing current-day MacBook snapshot produces `awaiting-source` and no public commit;
- pausing both heartbeats stops communication before any runtime removal.

- [ ] **Step 10: Record the final private checkpoint and commit public documentation only if changed**

The private checkpoint records approved source commit, runtime digests, non-sensitive success statuses, rollback order, and the fact that task IDs and private paths remain outside Git. If public documentation required a correction during rollout, commit only that correction:

```sh
git add docs/profile-activity.md .agents/skills/profile-activity/SKILL.md
git commit -m '활동 자동 갱신 운영 문서 보완'
git push origin main
```

Skip this commit when rollout required no public documentation change.
