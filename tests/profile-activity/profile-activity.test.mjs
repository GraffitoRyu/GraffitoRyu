import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, chmod, cp, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { aggregateSnapshots } from '../../scripts/profile-activity/aggregate.mjs';
import { collectLogRoots, probeLogRoots } from '../../scripts/profile-activity/collect.mjs';
import { parsePrivateSnapshot, parsePublicActivity, stableJson } from '../../scripts/profile-activity/contract.mjs';
import { assertAllowedPaths, publishGenerated, verifyRuntimeManifest, withPublisherLock } from '../../scripts/profile-activity/publish.mjs';
import { renderActivitySvg } from '../../scripts/profile-activity/render.mjs';
import { chooseLatestSnapshots, readSnapshot, saveAndExportSnapshot } from '../../scripts/profile-activity/snapshot.mjs';
import { SOURCE_A, SOURCE_B, call, makePublicActivity, makeSnapshot, message, rolloutLines } from './fixtures.mjs';

const run = promisify(execFile);
const options = { asOfDate: '2026-09-13', referenceTime: '2026-09-13T09:00:00Z', expectedSourceIds: [SOURCE_A, SOURCE_B], independentSources: true };

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), 'profile-activity-'));
}

async function collectFiles(files, extra = {}) {
  const root = await temp();
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return collectLogRoots({ logRoots: [root], excludedRepoRoots: extra.excludedRepoRoots ?? [], from: '2026-09-12', to: '2026-09-13', cache: extra.cache });
}

async function publisherRepo() {
  const root = await temp();
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const hooks = path.join(root, 'hooks');
  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', repo]);
  await run('git', ['-C', repo, 'config', 'user.name', 'Synthetic Test']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'README.md'), 'keep\n');
  await run('git', ['-C', repo, 'add', 'README.md']);
  await run('git', ['-C', repo, 'commit', '-m', 'seed']);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  await run('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  await mkdir(hooks);
  await run('git', ['-C', repo, 'config', 'core.hooksPath', hooks]);
  return {
    root,
    remote,
    repo,
    hooks,
    config: { role: 'publisher', stateDir: path.join(root, 'state'), publisher: { repoDir: repo, remote, branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 2, hooksPath: hooks, hooksManifest: {} } },
    generated: { 'metrics/codex-activity.json': '{}\n', 'assets/codex-activity.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n' },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function approveHook(config, name, content, mode = 0o700) {
  config.publisher.hooksManifest[name] = { digest: createHash('sha256').update(content).digest('hex'), mode };
}

function tokenCount(timestamp, totalTokens, ordinal) {
  return {
    timestamp,
    ordinal,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: totalTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens,
        },
        last_token_usage: {
          input_tokens: totalTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens,
        },
        model_context_window: 258400,
      },
    },
  };
}

function insightSnapshot({ sourceId = SOURCE_A, sessions = 2, calls = 4, tokens = 10, maxSessionTokens = 10, longestSessionMinutes = 3 } = {}) {
  const snapshot = makeSnapshot({ sourceId, sessions, calls });
  return {
    ...snapshot,
    schemaVersion: 2,
    days: snapshot.days.map((day) => ({ ...day, tokens, maxSessionTokens, longestSessionMinutes })),
  };
}

test('T01 duplicate raw/archive copies do not increase counts', async () => {
  const content = rolloutLines({ events: [message('2026-09-12T01:00:00Z'), call('2026-09-12T01:01:00Z', 'call-a')] });
  const result = await collectFiles({ 'a.jsonl': content, 'archive.jsonl': content });
  assert.equal(result.days[0].activeSessions, 1);
  assert.equal(result.days[0].toolCalls, 1);
});

test('T01 incremental cache reads an append once and detects replacement', async () => {
  const root = await temp();
  const file = path.join(root, 'a.jsonl');
  await writeFile(file, rolloutLines({ events: [call('2026-09-12T01:00:00Z', 'a')] }));
  const first = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13' });
  await appendFile(file, JSON.stringify(call('2026-09-12T02:00:00Z', 'b')) + '\n');
  const second = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13', cache: first.cache });
  assert.equal(second.days[0].toolCalls, 2);
  await writeFile(file, rolloutLines({ id: 'session-b', events: [call('2026-09-12T03:00:00Z', 'c')] }));
  const replaced = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13', cache: second.cache });
  assert.equal(replaced.days[0].toolCalls, 1);
});

test('T02 one session active on two dates is two session-days', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [message('2026-09-12T01:00:00Z'), message('2026-09-13T01:00:00Z')] }) });
  assert.deepEqual(result.days.map(({ activeSessions }) => activeSessions), [1, 1]);
});

test('T03 KST midnight boundary is exact', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [message('2026-09-12T14:59:59Z'), message('2026-09-12T15:00:00Z')] }) });
  assert.deepEqual(result.days.map(({ activeSessions }) => activeSessions), [1, 1]);
});

test('T04 old session file still includes a recent resume event', async () => {
  const result = await collectFiles({ 'old-name.jsonl': rolloutLines({ events: [message('2026-09-13T01:00:00Z')] }) });
  assert.equal(result.days[1].activeSessions, 1);
});

test('T05 call output/replay is not a call and a new call ID is', async () => {
  const content = rolloutLines({ events: [
    call('2026-09-12T01:00:00Z', 'a'),
    { timestamp: '2026-09-12T01:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'a', output: 'CANARY' } },
    call('2026-09-12T01:00:00Z', 'a'),
    call('2026-09-12T01:02:00Z', 'b'),
  ] });
  assert.equal((await collectFiles({ 'a.jsonl': content })).days[0].toolCalls, 2);
});

test('T06 inherited child history is excluded', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [message('2026-09-12T01:00:00Z', { inherited: true }), call('2026-09-12T01:01:00Z', 'new', { provenance: 'new' })] }) });
  assert.equal(result.days[0].toolCalls, 1);
});

test('T07 unknown provenance makes coverage partial', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [message('2026-09-12T01:00:00Z', { provenance: 'mystery' })] }) });
  assert.equal(result.days[0].coverage, 'partial');
  assert.equal(result.days[0].active, false);
});

test('T08 a final unterminated JSONL line is deferred', async () => {
  const complete = rolloutLines({ events: [] });
  const result = await collectFiles({ 'a.jsonl': complete + JSON.stringify(message('2026-09-12T01:00:00Z')) });
  assert.equal(result.days[0].active, false);
});

test('T09 malformed middle line is partial without raw error output', async () => {
  const content = rolloutLines({ events: [] }) + '{PRIVATE-CANARY\n' + JSON.stringify(message('2026-09-12T01:00:00Z')) + '\n';
  const result = await collectFiles({ 'a.jsonl': content });
  assert.equal(result.days[0].coverage, 'partial');
});

test('T10 empty readable scope is zero while a missing scope fails', async () => {
  const root = await temp();
  const result = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13' });
  assert.equal(result.days[0].active, false);
  await assert.rejects(collectLogRoots({ logRoots: [path.join(root, 'missing')], from: '2026-09-12', to: '2026-09-13' }));
});

test('T11 two known independent sources aggregate by union and sum', () => {
  const result = aggregateSnapshots([makeSnapshot({ sessions: 2, calls: 10 }), makeSnapshot({ sourceId: SOURCE_B, sessions: 3, calls: 7 })], options);
  assert.deepEqual(result.summary, { activeDays: 30, sessionDays: 150, toolCalls: 510 });
});

test('T12 repeat delivery replaces instead of accumulating', () => {
  const a = makeSnapshot({ sessions: 2, calls: 10 });
  const b = makeSnapshot({ sourceId: SOURCE_B, sessions: 3, calls: 7 });
  assert.deepEqual(aggregateSnapshots([a, a, b], options), aggregateSnapshots([a, b], options));
});

test('T13 later revision replaces past dates', () => {
  const old = makeSnapshot({ calls: 1 });
  const revised = makeSnapshot({ revision: 2, calls: 4 });
  const b = makeSnapshot({ sourceId: SOURCE_B, calls: 2 });
  assert.equal(aggregateSnapshots([old, revised, b], options).summary.toolCalls, 180);
});

test('T14 downgrade is ignored and same-revision conflict is rejected', () => {
  const newer = makeSnapshot({ revision: 2, calls: 4 });
  assert.equal(chooseLatestSnapshots([newer, makeSnapshot({ calls: 1 })], [SOURCE_A])[0].revision, 2);
  assert.throws(() => chooseLatestSnapshots([makeSnapshot({ calls: 1 }), makeSnapshot({ calls: 2 })], [SOURCE_A]));
});

test('T15 a valid correction may decrease counts', () => {
  const corrected = makeSnapshot({ revision: 2, calls: 1 });
  const b = makeSnapshot({ sourceId: SOURCE_B, calls: 2 });
  assert.equal(aggregateSnapshots([makeSnapshot({ calls: 9 }), corrected, b], options).summary.toolCalls, 90);
});

test('T16 unregistered source and policy/timezone mismatch are rejected', () => {
  assert.throws(() => aggregateSnapshots([makeSnapshot({ sourceId: '33333333-3333-4333-8333-333333333333' })], options));
  assert.throws(() => parsePrivateSnapshot({ ...makeSnapshot(), timezone: 'UTC' }));
});

test('T17 an unknown source day produces null counts', () => {
  const result = aggregateSnapshots([makeSnapshot({ calls: 1 }), makeSnapshot({ sourceId: SOURCE_B, coverage: 'unknown' })], options);
  assert.equal(result.days[0].toolCalls, null);
});

test('T18 a never-received source cannot produce a ready graph', () => {
  assert.equal(aggregateSnapshots([makeSnapshot()], options).status, 'unavailable');
});

test('T19 unknown cross-device independence keeps counts unavailable', () => {
  const result = aggregateSnapshots([makeSnapshot({ calls: 1 }), makeSnapshot({ sourceId: SOURCE_B, calls: 1 })], { ...options, independentSources: false });
  assert.equal(result.summary.toolCalls, null);
});

test('T42 cumulative token snapshots count only positive session deltas', async () => {
  const first = rolloutLines({ events: [
    message('2026-09-12T00:01:00Z'),
    tokenCount('2026-09-12T00:02:00Z', 100, 1),
    tokenCount('2026-09-12T00:03:00Z', 100, 2),
    tokenCount('2026-09-12T00:04:00Z', 250, 3),
  ] });
  const second = rolloutLines({ id: 'session-b', events: [tokenCount('2026-09-12T00:02:00Z', 50, 1)] });
  const day = (await collectFiles({ 'a.jsonl': first, 'b.jsonl': second })).days[0];
  assert.equal(day.tokens, 300);
  assert.equal(day.maxSessionTokens, 250);
  assert.equal(day.longestSessionMinutes, 4);
});

test('T43 fork token baseline excludes copied parent usage', async () => {
  const records = [
    { timestamp: '2026-09-12T00:00:00Z', type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', subagent_history_start_ordinal: 10, cwd: '/work/project' } },
    tokenCount('2026-09-12T00:01:00Z', 900, 9),
    tokenCount('2026-09-12T00:02:00Z', 1000, 10),
    tokenCount('2026-09-12T00:03:00Z', 1100, 11),
  ];
  const content = records.map((value) => JSON.stringify(value)).join('\n') + '\n';
  const day = (await collectFiles({ 'child.jsonl': content })).days[0];
  assert.equal(day.tokens, 100);
  assert.equal(day.maxSessionTokens, 100);
});

test('T46 legacy collector caches are rebuilt for profile metrics', async () => {
  const root = await temp();
  await writeFile(path.join(root, 'a.jsonl'), rolloutLines({ events: [tokenCount('2026-09-12T00:02:00Z', 100, 1)] }));
  const first = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13' });
  const legacyCache = structuredClone(first.cache);
  for (const state of Object.values(legacyCache.files)) {
    delete state.cacheVersion;
    state.events = state.events.filter((event) => event.kind !== 'tokens');
  }
  const rebuilt = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13', cache: legacyCache });
  assert.equal(rebuilt.days[0].tokens, 100);
});

test('T47 malformed token telemetry makes its day unknown', async () => {
  const malformed = tokenCount('2026-09-12T00:02:00Z', 100, 1);
  malformed.payload.info.total_token_usage.total_tokens = '100';
  const day = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [malformed] }) })).days[0];
  assert.equal(day.tokens, null);
  assert.equal(day.coverage, 'unknown');
});

test('T44 non-independent sources publish conservative lower-bound insights', () => {
  const result = aggregateSnapshots([
    insightSnapshot({ sessions: 2, calls: 4, tokens: 10, maxSessionTokens: 10, longestSessionMinutes: 3 }),
    insightSnapshot({ sourceId: SOURCE_B, sessions: 3, calls: 7, tokens: 20, maxSessionTokens: 20, longestSessionMinutes: 4 }),
  ], { ...options, independentSources: false });
  assert.equal(result.aggregation, 'lower-bound');
  assert.deepEqual(result.summary, {
    activeDays: 30,
    sessionDays: 90,
    toolCalls: 210,
    totalTokens: 600,
    maxSessionTokens: 20,
    longestSessionMinutes: 4,
    currentStreakDays: 30,
    longestStreakDays: 30,
  });
});

test('T48 lower-bound summaries retain verified partial observations', () => {
  const snapshots = [insightSnapshot(), insightSnapshot({ sourceId: SOURCE_B, sessions: 3, calls: 7, tokens: 20, maxSessionTokens: 20, longestSessionMinutes: 4 })];
  for (const snapshot of snapshots) {
    const index = snapshot.days.findIndex((day) => day.date === '2026-08-15');
    snapshot.days[index] = { date: snapshot.days[index].date, active: null, activeSessions: null, toolCalls: null, tokens: null, maxSessionTokens: null, longestSessionMinutes: null, coverage: 'unknown' };
  }
  const result = aggregateSnapshots(snapshots, { ...options, independentSources: false });
  assert.deepEqual(result.summary, {
    activeDays: 29,
    sessionDays: 87,
    toolCalls: 203,
    totalTokens: 580,
    maxSessionTokens: 20,
    longestSessionMinutes: 4,
    currentStreakDays: 29,
    longestStreakDays: 29,
  });
});

test('T20 excluded profile repository activity does not self-inflate', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ cwd: '/profile', events: [call('2026-09-12T01:00:00Z', 'a')] }) }, { excludedRepoRoots: ['/profile'] });
  assert.equal(result.days[0].toolCalls, 0);
});

test('T21 probe/public output never contains raw canaries', async () => {
  const root = await temp();
  await writeFile(path.join(root, 'a.jsonl'), rolloutLines({ events: [message('2026-09-12T01:00:00Z')] }));
  assert.doesNotMatch(stableJson(await probeLogRoots([root])), /SYNTHETIC-CANARY|PRIVATE-PATH-CANARY/);
});

test('T22 strict schemas reject extras, negatives, invalid dates and NaN', () => {
  assert.throws(() => parsePublicActivity({ ...makePublicActivity(), sourceId: 'PRIVATE-CANARY' }));
  const negative = makePublicActivity();
  negative.days[0].toolCalls = -1;
  assert.throws(() => parsePublicActivity(negative));
  assert.throws(() => parsePrivateSnapshot({ ...makeSnapshot(), revision: Number.NaN }));
});

test('T23 temporary/conflicted snapshots are refused', async () => {
  const root = await temp();
  const file = path.join(root, 'source.json.tmp');
  await writeFile(file, stableJson(makeSnapshot()));
  await assert.rejects(readSnapshot(file, root));
});

test('T24 symlinks cannot escape log or snapshot scopes', async () => {
  const root = await temp();
  const outside = await temp();
  await writeFile(path.join(outside, 'a.jsonl'), rolloutLines());
  await symlink(path.join(outside, 'a.jsonl'), path.join(root, 'a.jsonl'));
  await assert.rejects(collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13' }));
});

test('T24 publisher refuses generated symlinks before writing or pushing', async () => {
  const fixture = await publisherRepo();
  const outside = path.join(fixture.root, 'outside.json');
  await writeFile(outside, 'preserve\n');
  await mkdir(path.join(fixture.repo, 'metrics'));
  await symlink('../../../outside.json', path.join(fixture.repo, 'metrics', 'codex-activity.json'));
  await run('git', ['-C', fixture.repo, 'add', 'metrics/codex-activity.json']);
  await run('git', ['-C', fixture.repo, 'commit', '-m', 'synthetic symlink']);
  await run('git', ['-C', fixture.repo, 'push', 'origin', 'main']);
  const before = (await run('git', ['--git-dir', fixture.remote, 'rev-parse', 'main'])).stdout.trim();

  await assert.rejects(publishGenerated(fixture.config, fixture.generated));

  assert.equal(await readFile(outside, 'utf8'), 'preserve\n');
  assert.equal((await run('git', ['--git-dir', fixture.remote, 'rev-parse', 'main'])).stdout.trim(), before);
});

test('T24 publisher refuses a generated parent symlink without touching its target', async () => {
  const fixture = await publisherRepo();
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'codex-activity.json'), 'preserve\n');
  await symlink('../../outside', path.join(fixture.repo, 'metrics'));
  await run('git', ['-C', fixture.repo, 'add', 'metrics']);
  await run('git', ['-C', fixture.repo, 'commit', '-m', 'synthetic parent symlink']);
  await run('git', ['-C', fixture.repo, 'push', 'origin', 'main']);

  await assert.rejects(publishGenerated(fixture.config, fixture.generated));
  assert.equal(await readFile(path.join(outside, 'codex-activity.json'), 'utf8'), 'preserve\n');
});

test('T25 JSON and SVG are byte deterministic', () => {
  const value = makePublicActivity({ calls: 3 });
  assert.equal(stableJson(value), stableJson(value));
  assert.equal(renderActivitySvg(value), renderActivitySvg(value));
});

test('T26 SVG has escaped fixed text and no active/external content', () => {
  const svg = renderActivitySvg(makePublicActivity({ calls: 3 }));
  assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)=|on[a-z]+=/i);
});

test('T27 renderer distinguishes zero, null and large values', () => {
  assert.match(renderActivitySvg(makePublicActivity()), />0</);
  assert.match(renderActivitySvg(makePublicActivity({ unknown: true })), /Unavailable|unavailable/);
  assert.match(renderActivitySvg(makePublicActivity({ calls: 100000000 })), /3,000,000,000/);
});

test('T45 profile renderer shows safe lower-bound insights', () => {
  const value = aggregateSnapshots([
    insightSnapshot({ sessions: 2, calls: 4, tokens: 10, maxSessionTokens: 10, longestSessionMinutes: 3 }),
    insightSnapshot({ sourceId: SOURCE_B, sessions: 3, calls: 314, tokens: 40000000, maxSessionTokens: 250000000, longestSessionMinutes: 4 }),
  ], { ...options, independentSources: false });
  const svg = renderActivitySvg(value);
  assert.match(svg, /Codex profile/);
  assert.match(svg, /30d tokens/);
  assert.match(svg, /≥1\.2B/);
  assert.match(svg, /250M/);
  assert.match(svg, /≥9\.4K/);
  assert.match(svg, /Current streak/);
  assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)=|on[a-z]+=/i);
});

test('T28 only one publisher acquires the lock', async () => {
  const root = await temp();
  const first = await withPublisherLock(root, async () => withPublisherLock(root, async () => ({ status: 'wrong' })));
  assert.deepEqual(first, { status: 'skipped-lock' });
});

test('T29 collector role cannot publish', async () => {
  const { validatePublisherTarget } = await import('../../scripts/profile-activity/publish.mjs');
  await assert.rejects(validatePublisherTarget({ role: 'collector' }));
});

test('T30 a mismatched remote is rejected', async () => {
  const root = await temp();
  await run('git', ['init', root]);
  await run('git', ['-C', root, 'remote', 'add', 'origin', 'expected']);
  const { validatePublisherTarget } = await import('../../scripts/profile-activity/publish.mjs');
  await assert.rejects(validatePublisherTarget({ role: 'publisher', publisher: { repoDir: root, remote: 'other', hooksPath: '' } }));
});

test('T31 staged paths outside the two-file allowlist are rejected', () => {
  assert.doesNotThrow(() => assertAllowedPaths(['metrics/codex-activity.json']));
  assert.throws(() => assertAllowedPaths(['README.md']));
});

test('T32 non-fast-forward retry starts from the new remote and preserves README', async () => {
  const fixture = await publisherRepo();
  const other = path.join(fixture.root, 'other');
  const hook = path.join(fixture.hooks, 'pre-push');
  await run('git', ['clone', '-q', fixture.remote, other]);
  await run('git', ['-C', other, 'config', 'user.name', 'Concurrent User']);
  await run('git', ['-C', other, 'config', 'user.email', 'concurrent@example.invalid']);
  await writeFile(path.join(other, 'README.md'), 'keep\npreserve\n');
  await run('git', ['-C', other, 'add', 'README.md']);
  await run('git', ['-C', other, 'commit', '-qm', 'concurrent']);
  const concurrent = (await run('git', ['-C', other, 'rev-parse', 'HEAD'])).stdout.trim();
  await run('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:refs/heads/concurrent-test']);
  const marker = path.join(fixture.root, 'concurrent-once');
  const hookContent = `#!/bin/sh\nif [ ! -e ${shellQuote(marker)} ]; then\n  : > ${shellQuote(marker)}\n  git --git-dir=${shellQuote(fixture.remote)} update-ref refs/heads/main ${shellQuote(concurrent)}\nfi\n`;
  await writeFile(hook, hookContent);
  await chmod(hook, 0o700);
  approveHook(fixture.config, 'pre-push', hookContent);
  assert.match((await publishGenerated(fixture.config, fixture.generated)).status, /^(published|no-op)$/);
  const { stdout } = await run('git', ['--git-dir', fixture.remote, 'show', 'main:README.md']);
  assert.match(stdout, /preserve/);
  assert.equal((await run('git', ['--git-dir', fixture.remote, 'show', 'main:metrics/codex-activity.json'])).stdout, '{}\n');
});

test('T33 failed pushes stop after the configured retry bound', async () => {
  const fixture = await publisherRepo();
  const countFile = path.join(fixture.root, 'attempts');
  const hook = path.join(fixture.hooks, 'pre-push');
  const hookContent = `#!/bin/sh\nprintf x >> ${shellQuote(countFile)}\nexit 1\n`;
  await writeFile(hook, hookContent);
  await chmod(hook, 0o700);
  approveHook(fixture.config, 'pre-push', hookContent);
  await assert.rejects(publishGenerated(fixture.config, fixture.generated));
  assert.equal((await readFile(countFile, 'utf8')).length, 3);
});

test('T34 unchanged generated files create no empty commit', async () => {
  const fixture = await publisherRepo();
  assert.equal((await publishGenerated(fixture.config, fixture.generated)).status, 'published');
  assert.equal((await publishGenerated(fixture.config, fixture.generated)).status, 'no-op');
});

test('T35 a changed installed runtime fails digest verification', async () => {
  const root = await temp();
  await writeFile(path.join(root, 'cli.mjs'), 'changed');
  await assert.rejects(verifyRuntimeManifest(root, { 'cli.mjs': '0'.repeat(64) }));
});

test('T35 runtime manifest refuses symlink entries', async () => {
  const root = await temp();
  const content = 'approved\n';
  await writeFile(path.join(root, 'actual.mjs'), content);
  await symlink('actual.mjs', path.join(root, 'cli.mjs'));
  await assert.rejects(verifyRuntimeManifest(root, { 'cli.mjs': createHash('sha256').update(content).digest('hex') }));
});

test('T35 an empty runtime manifest is rejected', async () => {
  await assert.rejects(verifyRuntimeManifest(await temp(), {}));
});

test('T35 operational CLI rejects an empty manifest before writing state', async () => {
  const root = await temp();
  const logs = path.join(root, 'logs');
  const stateDir = path.join(root, 'state');
  const configFile = path.join(root, 'config.json');
  await mkdir(logs);
  await writeFile(configFile, stableJson({
    schemaVersion: 1,
    role: 'collector',
    sourceId: SOURCE_A,
    policyId: 'local-codex-v1-kst-exclude-profile',
    codexHome: root,
    logRoots: [logs],
    stateDir,
    transportDir: null,
    runtimeDir: path.resolve('scripts/profile-activity'),
    runtimeManifest: {},
    excludedRepoRoots: [],
    expectedSources: [],
    independentSources: false,
    publicDays: 30,
    retentionDays: 90,
    staleAfterHours: 48,
    timezone: 'Asia/Seoul',
  }));

  await assert.rejects(run(process.execPath, ['scripts/profile-activity/cli.mjs', 'collect', '--config', configFile, '--as-of', '2026-09-13']));
  await assert.rejects(readFile(path.join(stateDir, 'snapshot.json'), 'utf8'));
});

test('T35 runtime verification happens before local modules execute', async () => {
  const root = await temp();
  const runtimeDir = path.join(root, 'runtime');
  const logs = path.join(root, 'logs');
  const marker = path.join(root, 'module-ran');
  const configFile = path.join(root, 'config.json');
  await cp(path.resolve('scripts/profile-activity'), runtimeDir, { recursive: true });
  await mkdir(logs);
  const aggregateFile = path.join(runtimeDir, 'aggregate.mjs');
  const approved = await readFile(aggregateFile);
  await writeFile(aggregateFile, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n${approved}`);
  await writeFile(configFile, stableJson({
    schemaVersion: 1,
    role: 'collector',
    sourceId: SOURCE_A,
    policyId: 'local-codex-v1-kst-exclude-profile',
    codexHome: root,
    logRoots: [logs],
    stateDir: path.join(root, 'state'),
    transportDir: null,
    runtimeDir,
    runtimeManifest: { 'aggregate.mjs': createHash('sha256').update(approved).digest('hex') },
    excludedRepoRoots: [],
    expectedSources: [],
    independentSources: false,
    publicDays: 30,
    retentionDays: 90,
    staleAfterHours: 48,
    timezone: 'Asia/Seoul',
  }));

  await assert.rejects(run(process.execPath, [path.join(runtimeDir, 'cli.mjs'), 'probe', '--config', configFile]));
  await assert.rejects(readFile(marker, 'utf8'));
});

test('T39 changed hook content is rejected before the hook can execute', async () => {
  const fixture = await publisherRepo();
  const hook = path.join(fixture.hooks, 'pre-push');
  const marker = path.join(fixture.root, 'hook-ran');
  const approved = '#!/bin/sh\nexit 0\n';
  await writeFile(hook, approved);
  await chmod(hook, 0o700);
  fixture.config.publisher.hooksManifest = {
    'pre-push': { digest: createHash('sha256').update(approved).digest('hex'), mode: 0o700 },
  };
  await writeFile(hook, `#!/bin/sh\nprintf x >> ${shellQuote(marker)}\n`);

  await assert.rejects(publishGenerated(fixture.config, fixture.generated));
  await assert.rejects(readFile(marker, 'utf8'));
});

test('T39 added hooks and changed hook modes are rejected', async () => {
  const added = await publisherRepo();
  await writeFile(path.join(added.hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(added.hooks, 'pre-commit'), 0o700);
  await assert.rejects(publishGenerated(added.config, added.generated));

  const changedMode = await publisherRepo();
  const hook = path.join(changedMode.hooks, 'pre-push');
  const content = '#!/bin/sh\nexit 0\n';
  await writeFile(hook, content);
  await chmod(hook, 0o700);
  approveHook(changedMode.config, 'pre-push', content);
  await chmod(hook, 0o755);
  await assert.rejects(publishGenerated(changedMode.config, changedMode.generated));
});

test('T40 central eligibility permits partial but refuses unavailable data', async () => {
  const { isPublishableActivity } = await import('../../scripts/profile-activity/contract.mjs');
  assert.equal(isPublishableActivity({ ...makePublicActivity(), status: 'partial' }), true);
  assert.equal(isPublishableActivity(makePublicActivity({ unknown: true })), false);
});

test('T41 installer uses the approved commit bytes instead of dirty source', async () => {
  const root = await temp();
  const source = path.join(root, 'source');
  const sourceScripts = path.join(source, 'scripts', 'profile-activity');
  await mkdir(path.dirname(sourceScripts), { recursive: true });
  await cp(path.resolve('scripts/profile-activity'), sourceScripts, { recursive: true });
  await run('git', ['init', '--initial-branch=main', source]);
  await run('git', ['-C', source, 'config', 'user.name', 'Synthetic Test']);
  await run('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
  const hooks = path.join(root, 'hooks');
  await mkdir(hooks);
  await run('git', ['-C', source, 'config', 'core.hooksPath', hooks]);
  await run('git', ['-C', source, 'add', 'scripts/profile-activity']);
  await run('git', ['-C', source, 'commit', '-m', 'approved source']);
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const aggregateFile = path.join(sourceScripts, 'aggregate.mjs');
  const approved = await readFile(aggregateFile, 'utf8');
  await writeFile(aggregateFile, `${approved}\n// dirty source must not install\n`);
  const stateDir = path.join(root, 'state');
  const runtimeRoot = path.join(root, 'runtime');
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, stableJson({
    schemaVersion: 1,
    role: 'publisher',
    sourceId: SOURCE_A,
    policyId: 'local-codex-v1-kst-exclude-profile',
    codexHome: root,
    logRoots: [root],
    stateDir,
    transportDir: root,
    runtimeDir: runtimeRoot,
    runtimeManifest: {},
    excludedRepoRoots: [],
    expectedSources: [
      { sourceId: SOURCE_A, location: 'local', file: path.join(root, 'a.json') },
      { sourceId: SOURCE_B, location: 'transport', file: path.join(root, 'b.json') },
    ],
    independentSources: true,
    publicDays: 30,
    retentionDays: 90,
    staleAfterHours: 48,
    timezone: 'Asia/Seoul',
    publisher: { repoDir: source, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath: hooks },
  }));

  const { stdout } = await run(process.execPath, [path.join(sourceScripts, 'install-local.mjs'), '--apply', '--config', configFile, '--source-commit', commit]);
  const result = JSON.parse(stdout);
  assert.equal(await readFile(path.join(runtimeRoot, result.runtimeDigest, 'aggregate.mjs'), 'utf8'), approved);
  const installedRuntime = path.join(runtimeRoot, result.runtimeDigest);
  const installedConfig = path.join(stateDir, 'installed-config.json');
  assert.deepEqual(JSON.parse(await readFile(installedConfig, 'utf8')).publisher.hooksManifest, {});
  const probe = JSON.parse((await run(process.execPath, [path.join(installedRuntime, 'cli.mjs'), 'probe', '--config', installedConfig])).stdout);
  assert.equal(probe.status, 'ok');
  const receiptFile = path.join(stateDir, 'installation-receipt.json');
  const receiptText = await readFile(receiptFile, 'utf8');
  const tamperedReceipt = { ...JSON.parse(receiptText), runtimeDir: path.join(root, 'other-runtime') };
  await writeFile(receiptFile, stableJson(tamperedReceipt));
  await assert.rejects(run(process.execPath, [path.join(sourceScripts, 'install-local.mjs'), '--remove', '--config', installedConfig]));
  assert.equal(await readFile(path.join(installedRuntime, 'aggregate.mjs'), 'utf8'), approved);
  await writeFile(receiptFile, receiptText);
  const removed = JSON.parse((await run(process.execPath, [path.join(sourceScripts, 'install-local.mjs'), '--remove', '--config', installedConfig])).stdout);
  assert.equal(removed.status, 'runtime-removed');
  await assert.rejects(readFile(path.join(installedRuntime, 'aggregate.mjs'), 'utf8'));
});

test('T36 an existing installation target is not overwritten', async () => {
  const root = await temp();
  await mkdir(path.join(root, 'owned'), { mode: 0o700 });
  await assert.rejects(mkdir(path.join(root, 'owned'), { recursive: false }));
});

test('T36 uninstall refuses a runtime directory containing unmanaged files', async () => {
  const root = await temp();
  const stateDir = path.join(root, 'state');
  const runtimeDir = path.join(root, 'deadbeef');
  const runtimeFile = path.join(runtimeDir, 'cli.mjs');
  const configFile = path.join(root, 'config.json');
  await mkdir(stateDir);
  await mkdir(runtimeDir);
  await writeFile(runtimeFile, 'managed\n');
  await writeFile(path.join(runtimeDir, 'unmanaged.txt'), 'preserve\n');
  const runtimeManifest = { 'cli.mjs': createHash('sha256').update('managed\n').digest('hex') };
  await writeFile(path.join(stateDir, 'installation-receipt.json'), stableJson({ runtimeDigest: 'deadbeef' }));
  await writeFile(configFile, stableJson({
    schemaVersion: 1,
    role: 'publisher',
    sourceId: SOURCE_A,
    policyId: 'local-codex-v1-kst-exclude-profile',
    codexHome: root,
    logRoots: [root],
    stateDir,
    transportDir: root,
    runtimeDir,
    runtimeManifest,
    excludedRepoRoots: [],
    expectedSources: [
      { sourceId: SOURCE_A, location: 'local', file: path.join(root, 'a.json') },
      { sourceId: SOURCE_B, location: 'transport', file: path.join(root, 'b.json') },
    ],
    independentSources: true,
    publicDays: 30,
    retentionDays: 90,
    staleAfterHours: 48,
    timezone: 'Asia/Seoul',
    publisher: { repoDir: root, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath: '' },
  }));

  await assert.rejects(run(process.execPath, ['scripts/profile-activity/install-local.mjs', '--remove', '--config', configFile], { cwd: path.resolve('.') }));
  assert.equal(await readFile(path.join(runtimeDir, 'unmanaged.txt'), 'utf8'), 'preserve\n');
});

test('T37 local snapshot survives export failure', async () => {
  const root = await temp();
  const blocked = path.join(root, 'blocked');
  await writeFile(blocked, 'not a directory');
  const localFile = path.join(root, 'snapshot.json');
  const result = await saveAndExportSnapshot({ snapshot: makeSnapshot(), localFile, localScope: root, exportFile: path.join(blocked, 'snapshot.json'), exportScope: blocked });
  assert.equal(result.delivery, 'delivery-pending');
  assert.equal((await readSnapshot(localFile, root)).revision, 1);
});

test('T38 export alone remains delivery-pending until receiver verification', async () => {
  const root = await temp();
  const transport = path.join(root, 'transport');
  await mkdir(transport);
  const result = await saveAndExportSnapshot({ snapshot: makeSnapshot(), localFile: path.join(root, 'snapshot.json'), localScope: root, exportFile: path.join(transport, 'source.json'), exportScope: transport });
  assert.equal(result.delivery, 'delivery-pending');
});
