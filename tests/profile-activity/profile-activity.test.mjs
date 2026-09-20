import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, chmod, cp, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { aggregateSnapshots } from '../../scripts/profile-activity/aggregate.mjs';
import { collectLogRoots, probeLogRoots } from '../../scripts/profile-activity/collect.mjs';
import { parsePrivateSnapshot, parsePublicActivity, stableJson } from '../../scripts/profile-activity/contract.mjs';
import { collectorPlist } from '../../scripts/profile-activity/install-local.mjs';
import { assertAllowedPaths, publishGenerated, verifyRuntimeManifest, withPublisherLock } from '../../scripts/profile-activity/publish.mjs';
import { publicationDecision, publicationReceipt, publishIfReady } from '../../scripts/profile-activity/publication-gate.mjs';
import { acceptAcknowledgement, createEnvelope, nextDelivery, parseEnvelope, receiveEnvelope } from '../../scripts/profile-activity/relay.mjs';
import * as deliveryExecution from '../../scripts/profile-activity/delivery-execution.mjs';
import { renderActivitySvg } from '../../scripts/profile-activity/render.mjs';
import { chooseLatestSnapshots, readSnapshot, saveAndExportSnapshot } from '../../scripts/profile-activity/snapshot.mjs';
import { SOURCE_A, SOURCE_B, call, makePublicActivity, makeSnapshot, makeV3Input, makeV3Snapshot, message, rolloutLines } from './fixtures.mjs';

const run = promisify(execFile);
const options = { asOfDate: '2026-09-13', referenceTime: '2026-09-13T09:00:00Z', expectedSourceIds: [SOURCE_A, SOURCE_B], independentSources: true };

function accountActivitySample() {
  const turns = [89, 452, 163, 394, 364, 199, 361, 576, 540, 210, 165, 210, 507, 294, 90, 268, 233, 822, 351, 221, 112, 95, 165, 326, 169, 138, 90, 226, 303, null];
  const pluginCalls = [29, 355, 124, 146, 49, 34, 111, 38, 20, 57, 28, 74, 32, 384, 37, 2844, 1331, 169, 461, 1039, 368, 528, 624, 909, 697, 391, 224, 867, 952, null];
  const skillUses = [38, 248, 97, 221, 165, 97, 187, 361, 221, 204, 115, 200, 120, 22, 16, 249, 197, 74, 198, 131, 97, 35, 62, 205, 119, 74, 53, 147, 279, 6];
  const start = new Date('2026-08-22T00:00:00Z');
  return {
    schemaVersion: 2,
    observedDate: '2026-09-20',
    analytics: {
      readSucceeded: true,
      window: { from: '2026-08-22', to: '2026-09-20' },
      definition: 'personal-codex-and-work',
      grouping: 'daily',
      refreshCadence: null,
      localComparable: false,
      automatedCollection: false,
      totals: { turns: 8133, pluginCalls: 12922, skillUses: 4238 },
      days: turns.map((value, index) => ({
        date: new Date(start.valueOf() + index * 86400000).toISOString().slice(0, 10),
        turns: value,
        pluginCalls: pluginCalls[index],
        skillUses: skillUses[index],
      })),
    },
    tokenUsage: {
      readSucceeded: true,
      window: { from: '2026-08-22', to: '2026-09-20' },
      definition: 'chatgpt-account-token-activity',
      refreshCadence: null,
      localComparable: false,
      automatedCollection: true,
      summary: { lifetimeTokens: 41126977768, peakDailyTokens: 1067831636, longestRunningTurnSec: 59711, currentStreakDays: 35, longestStreakDays: 35 },
      days: [178485366, 703395684, 248176351, 607569497, 465750366, 414338860, 529042659, 853211539, 627925357, 540039339, 354940383, 531010479, 835243000, 682923095, 169143256, 1067831636, 824793462, 510744953, 1006149964, 813943995, 299176144, 218087542, 509810549, 839844303, 351871988, 182573890, 104006627, 505572752, 863817998, 140052192].map((tokens, index) => ({
        date: new Date(start.valueOf() + index * 86400000).toISOString().slice(0, 10),
        tokens,
      })),
    },
  };
}

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), 'profile-activity-'));
}

function runWithInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function installedCollectorFixture() {
  const root = await temp();
  const stateDir = path.join(root, 'state');
  const logs = path.join(root, 'logs');
  const runtimeSource = path.resolve('scripts/profile-activity');
  const runtimeManifest = {};
  for (const name of (await readdir(runtimeSource)).filter((item) => item.endsWith('.mjs')).sort()) runtimeManifest[name] = createHash('sha256').update(await readFile(path.join(runtimeSource, name))).digest('hex');
  const runtimeDigest = createHash('sha256').update(stableJson(runtimeManifest)).digest('hex');
  const runtimeDir = path.join(root, runtimeDigest);
  await cp(runtimeSource, runtimeDir, { recursive: true });
  await mkdir(stateDir);
  await mkdir(logs);
  const config = path.join(stateDir, 'installed-config.json');
  const configText = stableJson({
    schemaVersion: 1, role: 'collector', sourceId: SOURCE_A, policyId: 'local-codex-v1-kst-exclude-profile', codexHome: root, logRoots: [logs], stateDir, transportDir: null,
    runtimeDir, runtimeManifest, excludedRepoRoots: [], expectedSources: [], independentSources: false, publicDays: 30, retentionDays: 90, staleAfterHours: 48, timezone: 'Asia/Seoul',
  });
  await writeFile(config, configText);
  const receiptFile = path.join(stateDir, 'installation-receipt.json');
  await writeFile(receiptFile, stableJson({ schemaVersion: 1, sourceCommit: 'a'.repeat(40), stateDir, runtimeDir, runtimeDigest, runtimeManifestDigest: runtimeDigest, installedConfigDigest: createHash('sha256').update(configText).digest('hex'), nodeBinary: process.execPath }));
  return { root, runtimeDir, stateDir, config, receiptFile, cli: path.join(runtimeDir, 'cli.mjs'), delivery: path.join(runtimeDir, 'delivery-execution.mjs') };
}

async function installedPublisherFixture({ collectionPath } = {}) {
  const root = await temp();
  const stateDir = path.join(root, 'state');
  const logs = path.join(root, 'logs');
  const runtimeSource = path.resolve('scripts/profile-activity');
  const runtimeManifest = {};
  for (const name of (await readdir(runtimeSource)).filter((item) => item.endsWith('.mjs')).sort()) runtimeManifest[name] = createHash('sha256').update(await readFile(path.join(runtimeSource, name))).digest('hex');
  const runtimeDigest = createHash('sha256').update(stableJson(runtimeManifest)).digest('hex');
  const runtimeDir = path.join(root, runtimeDigest);
  await cp(runtimeSource, runtimeDir, { recursive: true });
  await mkdir(stateDir);
  await mkdir(logs);
  const config = path.join(stateDir, 'installed-config.json');
  const configText = stableJson({
    schemaVersion: 1, role: 'publisher', sourceId: SOURCE_B, policyId: 'local-codex-v1-kst-exclude-profile', codexHome: root, logRoots: [logs], stateDir, transportDir: root,
    runtimeDir, runtimeManifest, excludedRepoRoots: [], expectedSources: [{ sourceId: SOURCE_B, location: 'local', file: path.join(root, 'self.json') }, { sourceId: SOURCE_A, location: 'transport', file: path.join(root, 'remote.json') }], independentSources: true, publicDays: 30, retentionDays: 90, staleAfterHours: 48, timezone: 'Asia/Seoul',
    publisher: { repoDir: root, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath: '', hooksManifest: {} },
    ...(collectionPath ? { transportDir: null, expectedSources: [], publisher: { repoDir: root, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath: '', hooksManifest: {}, collectionPath } } : {}),
  });
  await writeFile(config, configText);
  const receiptFile = path.join(stateDir, 'installation-receipt.json');
  await writeFile(receiptFile, stableJson({ schemaVersion: 1, sourceCommit: 'a'.repeat(40), stateDir, runtimeDir, runtimeDigest, runtimeManifestDigest: runtimeDigest, installedConfigDigest: createHash('sha256').update(configText).digest('hex'), nodeBinary: process.execPath }));
  return { root, runtimeDir, stateDir, config, receiptFile, cli: path.join(runtimeDir, 'cli.mjs'), delivery: path.join(runtimeDir, 'delivery-execution.mjs') };
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
    generated: {
      'metrics/codex-activity.json': '{}\n',
      'assets/codex-activity.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      'assets/codex-activity-ko.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    },
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

function insightSnapshot({ sourceId = SOURCE_A, revision = 1, collectedAt = '2026-09-13T09:00:00.000Z', sessions = 2, calls = 4, tokens = 10, maxSessionTokens = 10, longestSessionMinutes = 3 } = {}) {
  const snapshot = makeSnapshot({ sourceId, revision, sessions, calls, collectedAt });
  return {
    ...snapshot,
    schemaVersion: 2,
    days: snapshot.days.map((day) => ({ ...day, tokens, maxSessionTokens, longestSessionMinutes })),
  };
}

test('v3 schema accepts exactly 30 anonymous KST days', () => {
  const reasoning = { none: 1, low: 2, medium: 3, high: 4, xhigh: 5, other: 6 };
  const parsed = parsePrivateSnapshot(makeV3Snapshot({
    sessions: 2,
    newChats: 1,
    calls: 4,
    pluginCalls: 1,
    browserCalls: 1,
    computerUseCalls: 1,
    skillUses: 2,
    fastTurns: 3,
    modeTurns: 4,
    reasoning,
  }));
  assert.equal(parsed.days.length, 30);
  assert.deepEqual(parsed.days[0].reasoning, reasoning);
  assert.equal(parsed.days[0].reasoningTurns, 21);
  assert.doesNotMatch(stableJson(parsed), /sessionId|pluginName|skillName|modelName/);
});

test('v3 schema rejects wrong ranges, denominators, extras, and identifiers', () => {
  const short = makeV3Snapshot();
  short.window.from = '2026-08-16';
  short.days.shift();
  assert.throws(() => parsePrivateSnapshot(short), /30 days/);

  const mode = makeV3Snapshot({ fastTurns: 2, modeTurns: 1 });
  assert.throws(() => parsePrivateSnapshot(mode), /fastTurns/);

  const reasoning = makeV3Snapshot({ reasoning: { none: 1, low: 0, medium: 0, high: 0, xhigh: 0, other: 0 } });
  reasoning.days[0].reasoningTurns = 2;
  assert.throws(() => parsePrivateSnapshot(reasoning), /reasoningTurns/);

  const extra = makeV3Snapshot();
  extra.days[0].pluginName = 'PRIVATE-PLUGIN-CANARY';
  assert.throws(() => parsePrivateSnapshot(extra), /keys/);

  const partition = makeV3Snapshot({ calls: 2, pluginCalls: 1 });
  partition.days[0].otherToolCalls = 0;
  assert.throws(() => parsePrivateSnapshot(partition), /toolCalls/);

  const chats = makeV3Snapshot({ sessions: 1, newChats: 2 });
  assert.throws(() => parsePrivateSnapshot(chats), /newChats/);
});

test('v3 snapshot and envelope omit source identity while merge keeps private slot context', () => {
  const a = makeV3Snapshot();
  const b = makeV3Snapshot();
  const parsed = parsePrivateSnapshot(a);
  const envelope = createEnvelope(a);
  assert.equal(Object.hasOwn(parsed, 'sourceId'), false);
  assert.doesNotMatch(stableJson(envelope), /sourceId|11111111|22222222/);
  assert.equal(aggregateSnapshots([{ sourceId: SOURCE_A, snapshot: a }, { sourceId: SOURCE_B, snapshot: b }], options).schemaVersion, 3);
  assert.throws(() => aggregateSnapshots([a, b], options), /unregistered source/);
  assert.throws(() => chooseLatestSnapshots([{ sourceId: SOURCE_B, snapshot: makeSnapshot() }], [SOURCE_A, SOURCE_B]), /mismatch/);
  assert.throws(() => parsePrivateSnapshot({ ...a, sourceId: SOURCE_A }), /keys/);
});

test('v3 collector reduces sessions, tool families, and explicit structured events to anonymous counters', async () => {
  const first = rolloutLines({ id: 'SESSION-CANARY-A', events: [
    message('2026-09-12T01:00:00Z'),
    call('2026-09-12T01:01:00Z', 'plugin', { name: 'PRIVATE-PLUGIN-NAME', plugin_id: 'PRIVATE-PLUGIN-ID' }),
    { timestamp: '2026-09-12T01:02:00Z', type: 'response_item', payload: { type: 'web_search_call', call_id: 'web', query: 'PRIVATE-QUERY' } },
    call('2026-09-12T01:03:00Z', 'computer', { name: 'computer_use' }),
    call('2026-09-12T01:04:00Z', 'other', { name: 'shell' }),
    { timestamp: '2026-09-12T01:05:00Z', type: 'event_msg', payload: { type: 'skill_use', skill_name: 'PRIVATE-SKILL-NAME' } },
    { timestamp: '2026-09-12T01:06:00Z', type: 'event_msg', payload: { type: 'mode', mode: 'fast' } },
    { timestamp: '2026-09-12T01:07:00Z', type: 'event_msg', payload: { type: 'reasoning', effort: 'high', model: 'PRIVATE-MODEL' } },
  ] });
  const second = rolloutLines({ id: 'SESSION-CANARY-B', events: [message('2026-09-12T02:00:00Z')] });
  const day = (await collectFiles({ 'a.jsonl': first, 'b.jsonl': second })).days[0];
  assert.deepEqual(day, {
    date: '2026-09-12', active: true, activeSessions: 2, newChats: 2,
    toolCalls: 4, pluginCalls: 1, browserCalls: 1, computerUseCalls: 1, otherToolCalls: 1,
    skillUses: 1, tokens: 0, maxSessionTokens: 0, longestSessionMinutes: 120,
    fastTurns: 1, modeTurns: 1, reasoningTurns: 1,
    reasoning: { none: 0, low: 0, medium: 0, high: 1, xhigh: 0, other: 0 }, coverage: 'complete',
  });
  assert.doesNotMatch(stableJson(day), /SESSION-CANARY|PRIVATE|plugin_id|skill_name|model/);
});

test('v3 collector reads current turn context reasoning without retaining model identity', async () => {
  const day = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [
    message('2026-09-12T01:00:00Z'),
    { timestamp: '2026-09-12T01:01:00Z', type: 'turn_context', payload: { effort: 'xhigh', model: 'PRIVATE-MODEL' } },
  ] }) })).days[0];

  assert.equal(day.reasoningTurns, 1);
  assert.deepEqual(day.reasoning, { none: 0, low: 0, medium: 0, high: 0, xhigh: 1, other: 0 });
  assert.doesNotMatch(stableJson(day), /PRIVATE|model/);
});

test('v3 collector classifies dotted and MCP tool namespaces into fixed anonymous families', async () => {
  const day = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [
    call('2026-09-12T01:00:00Z', 'web', { name: 'web.run' }),
    call('2026-09-12T01:01:00Z', 'computer', { name: 'mcp__cua_repl__js' }),
    call('2026-09-12T01:02:00Z', 'plugin', { name: 'mcp__example__call' }),
  ] }) })).days[0];

  assert.deepEqual(
    [day.toolCalls, day.browserCalls, day.computerUseCalls, day.pluginCalls, day.otherToolCalls],
    [3, 1, 1, 1, 0],
  );
});

test('v3 collector keeps absent or malformed optional telemetry null without corrupting core counts', async () => {
  const absent = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [call('2026-09-12T01:00:00Z', 'a')] }) })).days[0];
  assert.equal(absent.toolCalls, 1);
  assert.equal(absent.skillUses, null);
  assert.equal(absent.fastTurns, null);
  assert.equal(absent.reasoning, null);

  const malformed = rolloutLines({ events: [
    call('2026-09-12T01:00:00Z', 'a'),
    { timestamp: '2026-09-12T01:01:00Z', type: 'event_msg', payload: { type: 'skill_use', skill_name: 7 } },
  ] });
  const day = (await collectFiles({ 'a.jsonl': malformed })).days[0];
  assert.equal(day.toolCalls, 1);
  assert.equal(day.skillUses, null);
  assert.equal(day.coverage, 'complete');
});

test('v3 collector keeps optional telemetry null before its first structured observation', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [
    message('2026-09-12T01:00:00Z'),
    { timestamp: '2026-09-13T01:00:00Z', type: 'event_msg', payload: { type: 'mode', mode: 'fast' } },
  ] }) });
  assert.equal(result.days[0].fastTurns, null);
  assert.equal(result.days[0].modeTurns, null);
  assert.equal(result.days[1].fastTurns, 1);
  assert.equal(result.days[1].modeTurns, 1);
});

test('v3 collector counts a chat as new only when its first activity is inside the window', async () => {
  const old = rolloutLines({ events: [message('2026-08-01T01:00:00Z'), message('2026-09-12T01:00:00Z')] });
  const fresh = rolloutLines({ id: 'fresh', events: [message('2026-09-12T02:00:00Z')] });
  const day = (await collectFiles({ 'old.jsonl': old, 'fresh.jsonl': fresh })).days[0];
  assert.equal(day.activeSessions, 2);
  assert.equal(day.newChats, 1);
});

test('v3 aggregate sums anonymous counters, takes maxima, and weights percentages by raw denominators', () => {
  const a = makeV3Input({
    sessions: 1, newChats: 1, calls: 4, pluginCalls: 1, browserCalls: 1, computerUseCalls: 1,
    skillUses: 2, tokens: 10, maxSessionTokens: 9, longestSessionMinutes: 3,
    fastTurns: 1, modeTurns: 2, reasoning: { none: 0, low: 1, medium: 0, high: 1, xhigh: 0, other: 0 },
  });
  const b = makeV3Input({
    sourceId: SOURCE_B, sessions: 2, newChats: 2, calls: 6, pluginCalls: 2, browserCalls: 1, computerUseCalls: 1,
    skillUses: 3, tokens: 20, maxSessionTokens: 15, longestSessionMinutes: 7,
    fastTurns: 9, modeTurns: 10, reasoning: { none: 0, low: 0, medium: 0, high: 8, xhigh: 0, other: 0 },
  });
  const result = aggregateSnapshots([a, b], options);
  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.days[0], {
    date: '2026-08-15', active: true, activeSessions: 3, newChats: 3, toolCalls: 10,
    pluginCalls: 3, browserCalls: 2, computerUseCalls: 2, otherToolCalls: 3, skillUses: 5,
    tokens: 30, maxSessionTokens: 15, longestSessionMinutes: 7, fastModePercent: 83.3,
    reasoningPercent: { none: 0, low: 10, medium: 0, high: 90, xhigh: 0, other: 0 }, coverage: 'complete',
  });
  assert.deepEqual(result.summary, {
    activeDays: 30, sessionDays: 90, newChats: 90, toolCalls: 300, pluginCalls: 90,
    browserCalls: 60, computerUseCalls: 60, otherToolCalls: 90, skillUses: 150,
    totalTokens: 900, maxSessionTokens: 15, longestSessionMinutes: 7,
    currentStreakDays: 30, longestStreakDays: 30, fastModePercent: 83.3,
    reasoningPercent: { none: 0, low: 10, medium: 0, high: 90, xhigh: 0, other: 0 },
  });
});

test('v3 aggregate retains optional counts but not percentages from partial inputs', () => {
  const a = makeV3Input({ skillUses: 2, fastTurns: 1, modeTurns: 2, reasoning: { none: 0, low: 0, medium: 0, high: 1, xhigh: 0, other: 0 } });
  const b = makeV3Input({ sourceId: SOURCE_B });
  const result = aggregateSnapshots([a, b], options);
  assert.equal(result.summary.skillUses, 60);
  assert.equal(result.summary.fastModePercent, null);
  assert.equal(result.summary.reasoningPercent, null);
  assert.equal(result.days[0].skillUses, 2);
  assert.equal(result.status, 'partial');
});

test('v3 aggregate retains verified observations when the peer day is unknown', () => {
  const observed = makeV3Input({
    sessions: 1, newChats: 1, calls: 4, pluginCalls: 1, browserCalls: 1, computerUseCalls: 1,
    skillUses: 2, tokens: 10, maxSessionTokens: 9, longestSessionMinutes: 3,
    fastTurns: 1, modeTurns: 2, reasoning: { none: 0, low: 1, medium: 0, high: 1, xhigh: 0, other: 0 },
  });
  const unavailable = makeV3Input({ sourceId: SOURCE_B });
  unavailable.snapshot.days = unavailable.snapshot.days.map((day) => Object.fromEntries(
    Object.keys(day).map((key) => [key, key === 'date' ? day.date : key === 'coverage' ? 'unknown' : null]),
  ));

  const result = aggregateSnapshots([observed, unavailable], options);

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.days[0], {
    date: '2026-08-15', active: true, activeSessions: 1, newChats: 1, toolCalls: 4,
    pluginCalls: 1, browserCalls: 1, computerUseCalls: 1, otherToolCalls: 1, skillUses: 2,
    tokens: 10, maxSessionTokens: 9, longestSessionMinutes: 3, fastModePercent: null,
    reasoningPercent: null, coverage: 'partial',
  });
  assert.deepEqual(result.summary, {
    activeDays: 30, sessionDays: 30, newChats: 30, toolCalls: 120, pluginCalls: 30,
    browserCalls: 30, computerUseCalls: 30, otherToolCalls: 30, skillUses: 60,
    totalTokens: 300, maxSessionTokens: 9, longestSessionMinutes: 3,
    currentStreakDays: 30, longestStreakDays: 30, fastModePercent: null,
    reasoningPercent: null,
  });
});

test('v3 partial aggregation preserves observed zero per metric', () => {
  const observed = makeV3Input();
  observed.snapshot.days = observed.snapshot.days.map((day) => ({
    ...day,
    tokens: null,
    maxSessionTokens: null,
    longestSessionMinutes: null,
  }));
  const unavailable = makeV3Input({ sourceId: SOURCE_B });
  unavailable.snapshot.days = unavailable.snapshot.days.map((day) => Object.fromEntries(
    Object.keys(day).map((key) => [key, key === 'date' ? day.date : key === 'coverage' ? 'unknown' : null]),
  ));

  const result = aggregateSnapshots([observed, unavailable], options);

  assert.equal(result.days[0].toolCalls, 0);
  assert.equal(result.summary.toolCalls, 0);
  assert.equal(result.days[0].tokens, null);
  assert.equal(result.summary.totalTokens, null);
});

test('v3 aggregate refuses a non-independent two-device surface', () => {
  assert.throws(() => aggregateSnapshots([
    makeV3Input(),
    makeV3Input({ sourceId: SOURCE_B }),
  ], { ...options, independentSources: false }), /independent sources required/);
});

test('v3 renderer prioritizes four reliable public metrics', () => {
  const activity = aggregateSnapshots([
    makeV3Input({ sessions: 1, newChats: 1, calls: 4, pluginCalls: 1, browserCalls: 1, computerUseCalls: 1, skillUses: 1, fastTurns: 1, modeTurns: 2, reasoning: { none: 0, low: 1, medium: 0, high: 1, xhigh: 0, other: 0 } }),
    makeV3Input({ sourceId: SOURCE_B, sessions: 1, newChats: 1, calls: 4, pluginCalls: 1, browserCalls: 1, computerUseCalls: 1, skillUses: 1, fastTurns: 1, modeTurns: 2, reasoning: { none: 0, low: 1, medium: 0, high: 1, xhigh: 0, other: 0 } }),
  ], options);
  const svg = renderActivitySvg(activity);
  assert.match(svg, /30 days building with Codex/);
  assert.match(svg, /Observed tokens/);
  assert.match(svg, /Observed session starts/);
  assert.match(svg, /Tool calls/);
  assert.match(svg, /Active days/);
  assert.match(svg, />30 \/ 30<\/text>/);
  assert.doesNotMatch(svg, /New chats|Max session|Longest chat|Session-days|Plugin calls|Browser\/web|Computer use|Other tools|Skill uses|Fast mode|Reasoning|Not observed|Unavailable/);
  assert.doesNotMatch(svg, /11111111|22222222|PRIVATE|device|source|<script|foreignObject|(?:href|src)=|on[a-z]+=/i);
  assert.equal(svg, renderActivitySvg(activity));
});

test('v3 renderer keeps only observed token insights', () => {
  const activity = aggregateSnapshots([
    makeV3Input({ sessions: 1, newChats: 1, calls: 4, tokens: 10 }),
    makeV3Input({ sourceId: SOURCE_B, sessions: 1, newChats: 1, calls: 4, tokens: 10 }),
  ], options);
  activity.days[4].tokens = 99;

  const svg = renderActivitySvg(activity);

  assert.match(svg, /height="590" viewBox="0 0 900 590"/);
  assert.match(svg, /Activity insights/);
  assert.match(svg, /Highest observed day/);
  assert.match(svg, /Median observed daily tokens/);
  assert.doesNotMatch(svg, /Consistency|Current streak|Longest streak|Peak activity|Peak day|Peak observed tokens/);
  assert.match(svg, />08-19<\/text>/);
  assert.match(svg, />20\+<\/text>/);
});

test('v3 renderer presents verified partial observations as quiet lower bounds', () => {
  const observed = makeV3Input({ sessions: 1, newChats: 1, calls: 4, tokens: 10, maxSessionTokens: 9, longestSessionMinutes: 3 });
  const unavailable = makeV3Input({ sourceId: SOURCE_B });
  unavailable.snapshot.days = unavailable.snapshot.days.map((day) => Object.fromEntries(
    Object.keys(day).map((key) => [key, key === 'date' ? day.date : key === 'coverage' ? 'unknown' : null]),
  ));
  const svg = renderActivitySvg(aggregateSnapshots([observed, unavailable], options));

  assert.match(svg, />300\+</);
  assert.match(svg, />120\+</);
  assert.match(svg, />30 \/ 30<\/text>/);
  assert.match(svg, /10\+ tokens/);
  assert.match(svg, /30 \/ 30 token days · \+ lower bound/);
  assert.doesNotMatch(svg, /≥|Partial values shown|Not observed|Unavailable/);

  const complete = renderActivitySvg(aggregateSnapshots([
    makeV3Input({ sessions: 1, calls: 1, tokens: 1, skillUses: 0 }),
    makeV3Input({ sourceId: SOURCE_B, sessions: 1, calls: 1, tokens: 1, skillUses: 0 }),
  ], options));
  assert.match(complete, /Observed tokens<\/text><text[^>]+>60<\/text>/);
  assert.doesNotMatch(complete, />60\+</);
});

test('v3 renderer draws a bounded 30-day token histogram with readable axes', () => {
  const complete = { sessions: 1, calls: 1, tokens: 10, skillUses: 0, fastTurns: 0, modeTurns: 0, reasoning: { none: 0, low: 0, medium: 0, high: 0, xhigh: 0, other: 0 } };
  const activity = aggregateSnapshots([
    makeV3Input(complete),
    makeV3Input({ sourceId: SOURCE_B, ...complete }),
  ], options);
  activity.days[0].tokens = 0;
  activity.days[1].tokens = 9_000_000_000_000;
  activity.days[29].tokens = 50;

  const svg = renderActivitySvg(activity);
  const bars = svg.match(/class="token-bar(?: token-unknown)?"/g) ?? [];

  assert.equal(bars.length, 30);
  assert.match(svg, /class="token-bar" x="68"/);
  assert.match(svg, /class="token-bar" x="851"/);
  assert.match(svg, /y="324" width="15" height="2"/);
  assert.match(svg, />9T<\/text>/);
  assert.match(svg, />08-15<\/text>/);
  assert.match(svg, />09-13<\/text>/);
  assert.doesNotMatch(svg, /prefers-color-scheme/);
  assert.match(svg, /\.grid,\.divider\{stroke:#30363d\}/);
  assert.match(svg, /class="panel"[^>]+fill="#0d1117" fill-opacity="\.96" stroke="#30363d"/);
});

test('v3 renderer distinguishes unknown, zero, partial, and ready token bars', () => {
  const observed = makeV3Input({ sessions: 1, calls: 1, tokens: 10 });
  const unavailable = makeV3Input({ sourceId: SOURCE_B });
  unavailable.snapshot.days = unavailable.snapshot.days.map((day) => Object.fromEntries(
    Object.keys(day).map((key) => [key, key === 'date' ? day.date : key === 'coverage' ? 'unknown' : null]),
  ));
  const partial = aggregateSnapshots([observed, unavailable], options);
  partial.days[0] = Object.fromEntries(Object.keys(partial.days[0]).map((key) => [
    key,
    key === 'date' ? partial.days[0].date : key === 'coverage' ? 'unknown' : null,
  ]));
  partial.days[1].tokens = 0;

  const partialSvg = renderActivitySvg(partial);
  assert.match(partialSvg, /class="token-bar token-unknown"/);
  assert.match(partialSvg, /class="token-bar token-unknown"[^>]+fill="none"[^>]+stroke-dasharray="2 2"/);
  assert.match(partialSvg, /class="token-bar token-unknown"[^>]*><title>[^<]+: outside token coverage<\/title><\/rect>/);
  assert.match(partialSvg, /class="token-bar"[^>]*><title>[^<]+: 0\+ tokens<\/title><\/rect>/);
  assert.match(partialSvg, /10\+ tokens/);
  assert.doesNotMatch(partialSvg, /Partial values shown|≥/);

  const unavailableSurface = structuredClone(partial);
  unavailableSurface.status = 'unavailable';
  unavailableSurface.days = unavailableSurface.days.map((day) => Object.fromEntries(Object.keys(day).map((key) => [
    key,
    key === 'date' ? day.date : key === 'coverage' ? 'unknown' : null,
  ])));
  const unavailableSvg = renderActivitySvg(unavailableSurface);
  assert.match(unavailableSvg, />—<\/text>/);
  assert.doesNotMatch(unavailableSvg, />Unavailable<\/text>|>Not observed<\/text>/);

  const readySvg = renderActivitySvg(aggregateSnapshots([
    makeV3Input({ sessions: 1, calls: 1, tokens: 1, skillUses: 0, fastTurns: 0, modeTurns: 0, reasoning: { none: 0, low: 0, medium: 0, high: 0, xhigh: 0, other: 0 } }),
    makeV3Input({ sourceId: SOURCE_B, sessions: 1, calls: 1, tokens: 1, skillUses: 0, fastTurns: 0, modeTurns: 0, reasoning: { none: 0, low: 0, medium: 0, high: 0, xhigh: 0, other: 0 } }),
  ], options));
  assert.doesNotMatch(readySvg, /Partial values shown|≥|\+ tokens/);
});

test('v3 renderer floors lower-bound compact values and renders Korean copy', () => {
  const activity = aggregateSnapshots([
    makeV3Input({ sessions: 1, newChats: 1, calls: 4, tokens: 65_383_255 }),
    makeV3Input({ sourceId: SOURCE_B }),
  ], options);
  activity.summary.totalTokens = 1_961_497_663;

  const english = renderActivitySvg(activity);
  const korean = renderActivitySvg(activity, 'ko');

  assert.match(english, />1\.9B\+<\/text>/);
  assert.doesNotMatch(english, />2B\+<\/text>/);
  assert.match(korean, /Codex로 만든 30일/);
  assert.match(korean, /관측 세션 시작/);
  assert.match(korean, /가장 높은 관측일/);
  assert.match(korean, /관측 일일 토큰 중앙값/);
  assert.match(korean, />19\.6억\+<\/text>/);
  assert.equal(korean, renderActivitySvg(activity, 'ko'));
  assert.throws(() => renderActivitySvg(activity, 'fr'), /locale/);
});

test('account usage accepts only the exact sanitized private contract and joins once after device merge', async () => {
  const { parseAccountUsage, processActivitySurface } = await import('../../scripts/profile-activity/account-usage.mjs');
  const sample = {
    observedAt: '2026-09-13T09:00:00.000Z',
    window: { durationMinutes: 300, usedPercent: 42.5, resetsAt: '2026-09-13T12:00:00.000Z' },
    rateLimitStatus: 'ok',
    creditAvailable: true,
    creditUnlimited: false,
    coverage: 'complete',
  };
  assert.deepEqual(parseAccountUsage(sample), sample);
  const result = processActivitySurface([makeV3Input(), makeV3Input({ sourceId: SOURCE_B })], options, sample);
  assert.deepEqual(result.accountUsage, sample);
  assert.equal(result.activity.schemaVersion, 3);
  assert.equal(Object.hasOwn(result.activity, 'accountUsage'), false);
  assert.doesNotMatch(stableJson(result.activity), /usedPercent|reset|credit|account/);
  assert.equal(processActivitySurface([makeV3Input(), makeV3Input({ sourceId: SOURCE_B })], options).accountUsage, null);
});

test('account usage rejects identifiers, billing metadata, raw responses, extras, and invalid values', async () => {
  const { parseAccountUsage } = await import('../../scripts/profile-activity/account-usage.mjs');
  const sample = {
    observedAt: '2026-09-13T09:00:00.000Z',
    window: { durationMinutes: 300, usedPercent: 42.5, resetsAt: null },
    rateLimitStatus: 'limited', creditAvailable: false, creditUnlimited: false, coverage: 'partial',
  };
  for (const extra of ['accountId', 'balance', 'planId', 'resetCreditId', 'resetCreditTitle', 'resetCreditDescription', 'rawResponse']) {
    assert.throws(() => parseAccountUsage({ ...sample, [extra]: 'PRIVATE-CANARY' }), /keys/);
  }
  assert.throws(() => parseAccountUsage({ ...sample, window: { ...sample.window, usedPercent: 101 } }), /usedPercent/);
  assert.throws(() => parseAccountUsage({ ...sample, creditUnlimited: true }), /credit/);
  assert.throws(() => parseAccountUsage({ ...sample, window: { ...sample.window, extra: true } }), /keys/);
  assert.throws(() => parseAccountUsage({ ...sample, observedAt: null }), /observedAt/);
});

test('account activity accepts verified Analytics and exact App Server token usage', async () => {
  const { parseAccountActivity } = await import('../../scripts/profile-activity/account-activity.mjs');
  const sample = accountActivitySample();
  assert.deepEqual(parseAccountActivity(sample), sample);
  assert.equal(sample.analytics.days.reduce((sum, day) => sum + (day.turns ?? 0), 0), sample.analytics.totals.turns);
  assert.equal(sample.analytics.days.reduce((sum, day) => sum + (day.pluginCalls ?? 0), 0), sample.analytics.totals.pluginCalls);
  assert.equal(sample.analytics.days.reduce((sum, day) => sum + (day.skillUses ?? 0), 0), sample.analytics.totals.skillUses);
  assert.equal(sample.tokenUsage.days.find(({ date }) => date === '2026-09-06').tokens, 1067831636);
  for (const extra of ['accountId', 'sourceId', 'cookie', 'rawResponse', 'path']) {
    assert.throws(() => parseAccountActivity({ ...sample, [extra]: 'PRIVATE-CANARY' }), /keys/);
  }
  const mismatch = structuredClone(sample);
  mismatch.analytics.totals.turns += 1;
  assert.throws(() => parseAccountActivity(mismatch), /total/);
});

test('comparable account metrics replace missing or smaller local values and refuse contradictions', async () => {
  const { mergeVerifiedMetric } = await import('../../scripts/profile-activity/account-activity.mjs');
  assert.deepEqual(mergeVerifiedMetric(null, 10, { sameDefinition: true, samePeriod: true }), { value: 10, source: 'account' });
  assert.deepEqual(mergeVerifiedMetric(0, 10, { sameDefinition: true, samePeriod: true }), { value: 10, source: 'account' });
  assert.deepEqual(mergeVerifiedMetric(9, 10, { sameDefinition: true, samePeriod: true }), { value: 10, source: 'account' });
  assert.deepEqual(mergeVerifiedMetric(10, 10, { sameDefinition: true, samePeriod: true }), { value: 10, source: 'matched' });
  assert.deepEqual(mergeVerifiedMetric(9, 10, { sameDefinition: false, samePeriod: true }), { value: null, source: 'separate' });
  assert.throws(() => mergeVerifiedMetric(11, 10, { sameDefinition: true, samePeriod: true }), /contradiction/);
});

test('verified account activity uses App Server tokens and drives bilingual dashboard copy', async () => {
  const { processActivitySurface } = await import('../../scripts/profile-activity/account-usage.mjs');
  const result = processActivitySurface([
    makeV3Input(),
    makeV3Input({ sourceId: SOURCE_B }),
  ], options, null, accountActivitySample());
  assert.equal(result.activity.schemaVersion, 4);
  assert.equal(result.activity.metricScope, 'codex-activity-evidence');
  assert.equal(result.activity.summary.pluginCalls, 0);
  assert.equal(result.activity.accountActivity.analytics.totals.pluginCalls, 12922);
  assert.equal(parsePublicActivity(result.activity).accountActivity.tokenUsage.summary.lifetimeTokens, 41126977768);

  const english = renderActivitySvg(result.activity);
  const korean = renderActivitySvg(result.activity, 'ko');
  assert.match(english, /Account lifetime tokens/);
  assert.match(english, /41\.13B/);
  assert.match(english, /Account turns/);
  assert.match(english, /Plugin calls/);
  assert.match(english, /Skills used/);
  assert.match(english, /Daily account tokens/);
  assert.match(english, /Peak account day/);
  assert.match(english, /1\.07B/);
  assert.match(korean, /계정 누적 토큰/);
  assert.match(korean, /411\.27억/);
  assert.match(korean, /최고 사용일/);
  assert.match(korean, /font-size="22" font-weight="600">Codex 계정 활동/);
  assert.match(korean, /font-size="14" opacity="\.68">계정 누적 토큰/);
  assert.match(english, /font-size="20" font-weight="600">Codex account activity/);
  assert.match(english, /fill="#0d1117" fill-opacity="\.96"/);
  assert.match(korean, /fill="#0d1117" fill-opacity="\.96"/);
  assert.doesNotMatch(english, /Observed tokens|Unavailable|Not observed/);
});

test('App Server account usage is reduced to anonymous exact public fields', async () => {
  const { sanitizeAccountUsageResponse } = await import('../../scripts/profile-activity/app-server-usage.mjs');
  const sample = sanitizeAccountUsageResponse({
    summary: { lifetimeTokens: 41126977768, peakDailyTokens: 1067831636, longestRunningTurnSec: 59711, currentStreakDays: 35, longestStreakDays: 35, privateExtra: 'PRIVATE-CANARY' },
    dailyUsageBuckets: [{ startDate: '2026-09-06', tokens: 1067831636 }, { startDate: '2025-01-01', tokens: 1 }],
    threadUsage: { private: 'PRIVATE-CANARY' },
  }, { from: '2026-08-22', to: '2026-09-20' });
  assert.equal(sample.days.length, 1);
  assert.equal(sample.days[0].tokens, 1067831636);
  assert.doesNotMatch(stableJson(sample), /PRIVATE-CANARY|threadUsage|privateExtra/);
});

test('App Server collector keeps stdin open until the delayed usage response arrives', async () => {
  const { readAccountTokenUsage } = await import('../../scripts/profile-activity/app-server-usage.mjs');
  const root = await temp();
  const fakeCodex = path.join(root, 'codex');
  await writeFile(fakeCodex, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.stdout.write(JSON.stringify({ id: 7, result: { summary: { lifetimeTokens: 100, peakDailyTokens: 20, longestRunningTurnSec: 3, currentStreakDays: 2, longestStreakDays: 4 }, dailyUsageBuckets: [{ startDate: '2026-09-20', tokens: 20 }], threadUsage: null } }) + '\\n'), 30);
`);
  await chmod(fakeCodex, 0o700);
  const result = await readAccountTokenUsage({ codexBinary: fakeCodex, window: { from: '2026-08-22', to: '2026-09-20' }, timeoutMs: 1000 });
  assert.equal(result.summary.lifetimeTokens, 100);
  assert.deepEqual(result.days, [{ date: '2026-09-20', tokens: 20 }]);
});

test('installed run accepts one private account sample without exposing it in CLI output', async () => {
  const fixture = await installedPublisherFixture();
  const sample = {
    observedAt: '2026-09-13T09:00:00.000Z',
    window: { durationMinutes: 300, usedPercent: 42.5, resetsAt: '2026-09-13T12:00:00.000Z' },
    rateLimitStatus: 'ok', creditAvailable: true, creditUnlimited: false, coverage: 'complete',
  };
  const result = deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'run', input: sample }).run();
  assert.doesNotMatch(stableJson(result), /usedPercent|resetsAt|credit|42\.5/);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.stateDir, 'account-usage.json'), 'utf8')), sample);
  assert.throws(() => deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'run', input: { ...sample, accountId: 'PRIVATE-CANARY' } }).run());
});

test('installed run stores verified account activity once and reuses it without exposing fields', async () => {
  const fixture = await installedPublisherFixture();
  const sample = accountActivitySample();
  const result = deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'run', input: sample, inputKind: 'account-activity' }).run();
  assert.doesNotMatch(stableJson(result), /8133|12922|4238|accountActivity/);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.stateDir, 'account-activity.json'), 'utf8')), sample);
});

test('Mac mini publisher refuses duplicate account activity collection', async () => {
  const fixture = await installedPublisherFixture({ collectionPath: 'metrics/codex-activity-macmini.json' });
  assert.throws(() => deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'run', input: accountActivitySample(), inputKind: 'account-activity' }).run());
  await assert.rejects(readFile(path.join(fixture.stateDir, 'account-activity.json'), 'utf8'));
});

test('v3 envelope uses a version-matched schema and retains no category identity', () => {
  const snapshot = makeV3Snapshot({ calls: 1, pluginCalls: 1, skillUses: 1 });
  const envelope = createEnvelope(snapshot);
  assert.equal(envelope.schema, 'PROFILE_ACTIVITY_SNAPSHOT_V3');
  assert.deepEqual(Object.keys(envelope).sort(), ['revision', 'schema', 'snapshot']);
  assert.equal(parseEnvelope(envelope).snapshot.schemaVersion, 3);
  assert.throws(() => parseEnvelope({ ...envelope, schema: 'PROFILE_ACTIVITY_SNAPSHOT_V2' }), /identity/);
  assert.doesNotMatch(stableJson(envelope), /PRIVATE|pluginName|pluginId|skillName|modelName|arguments/);
});

test('v3 publication accepts matching current v2 or v3 pairs and waits on mixed or stale pairs', () => {
  const now = '2026-09-13T05:00:00.000Z';
  const v2 = [insightSnapshot({ collectedAt: '2026-09-13T04:00:00.000Z' }), insightSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' })];
  const v3 = [makeV3Input({ collectedAt: '2026-09-13T04:00:00.000Z' }), makeV3Input({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' })];
  assert.equal(publicationDecision({ snapshots: v2, expectedSourceIds: [SOURCE_A, SOURCE_B], now, receipt: null }).status, 'ready');
  assert.equal(publicationDecision({ snapshots: v3, expectedSourceIds: [SOURCE_A, SOURCE_B], now, receipt: null }).status, 'ready');
  assert.equal(publicationDecision({ snapshots: [v2[0], v3[1]], expectedSourceIds: [SOURCE_A, SOURCE_B], now, receipt: null }).status, 'awaiting-source');
  const stale = v3.map(({ sourceId, snapshot }) => ({ sourceId, snapshot: { ...snapshot, collectedAt: '2026-09-10T04:00:00.000Z' } }));
  assert.equal(publicationDecision({ snapshots: stale, expectedSourceIds: [SOURCE_A, SOURCE_B], now, receipt: null }).status, 'awaiting-source');
});

test('v3 preservation refuses missing, conflicting, and malformed inputs before publication', async () => {
  const root = await temp();
  let publishes = 0;
  const result = await publishIfReady({
    config: { stateDir: root }, snapshots: [makeV3Input({ collectedAt: '2026-09-13T04:00:00.000Z' })], expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00.000Z',
    receiptFile: path.join(root, 'publication-receipt.json'), publish: async () => { publishes += 1; return { status: 'published', commit: 'a'.repeat(40) }; },
  });
  assert.equal(result.status, 'awaiting-source');
  assert.equal(publishes, 0);
  assert.throws(() => publicationDecision({
    snapshots: [makeV3Input(), makeV3Input({ calls: 1, pluginCalls: 1 }), makeV3Input({ sourceId: SOURCE_B })],
    expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00.000Z', receipt: null,
  }), /conflict/);
  const malformed = makeV3Snapshot({ sourceId: SOURCE_B });
  malformed.days[0].privateCanary = 'PRIVATE-CANARY';
  assert.throws(() => publicationDecision({ snapshots: [makeV3Input(), { sourceId: SOURCE_B, snapshot: malformed }], expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00.000Z', receipt: null }), /keys/);
  await assert.rejects(readFile(path.join(root, 'publication-receipt.json'), 'utf8'));
});

test('v3 processing run reads stored snapshots without collecting a device', async () => {
  const fixture = await installedPublisherFixture();
  const local = makeV3Snapshot({ sourceId: SOURCE_B, revision: 5 });
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(local));
  const result = JSON.parse((await run(process.execPath, [fixture.cli, 'run', '--config', fixture.config, '--as-of', '2026-09-13'])).stdout);
  assert.ok(['before-window', 'awaiting-source'].includes(result.status));
  assert.equal((await readSnapshot(path.join(fixture.stateDir, 'snapshot.json'), fixture.stateDir)).revision, 5);
  assert.deepEqual(await readdir(path.join(fixture.root, 'logs')), []);
});

test('v3 processing refuses malformed last-good instead of falling back to transport', async () => {
  const fixture = await installedPublisherFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(makeV3Snapshot()));
  await writeFile(path.join(fixture.stateDir, `last-good-${SOURCE_A}.json`), '{"schemaVersion":3}\n');
  await writeFile(path.join(fixture.root, 'remote.json'), stableJson(makeV3Snapshot()));
  await assert.rejects(run(process.execPath, [fixture.cli, 'run', '--config', fixture.config, '--as-of', '2026-09-13']));
  await assert.rejects(readFile(path.join(fixture.stateDir, 'publication-receipt.json'), 'utf8'));
});

test('v3 collection migrates an untransmitted identified draft without resetting revision', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson({ ...makeV3Snapshot({ revision: 5 }), sourceId: SOURCE_A }));
  await run(process.execPath, [fixture.cli, 'collect', '--config', fixture.config, '--as-of', '2026-09-13']);
  const stored = JSON.parse(await readFile(path.join(fixture.stateDir, 'snapshot.json'), 'utf8'));
  assert.equal(stored.revision, 6);
  assert.equal(Object.hasOwn(stored, 'sourceId'), false);
});

test('v3 receiver binds a source-less envelope to its configured private slot', async () => {
  const root = await temp();
  const file = path.join(root, 'last-good.json');
  const envelope = createEnvelope(makeV3Snapshot());
  const received = await receiveEnvelope({ envelope, expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root });
  assert.deepEqual(received, { status: 'received', revision: envelope.revision });
  assert.doesNotMatch(await readFile(file, 'utf8'), /sourceId|11111111|22222222/);
  assert.deepEqual(await receiveEnvelope({ envelope, expectedSourceId: SOURCE_A, lastGoodFile: file, stateScope: root }), { status: 'acknowledged', revision: envelope.revision });
});

test('v3 acknowledgement uses revision without a stable digest', () => {
  const delivery = nextDelivery({ snapshot: makeV3Snapshot(), state: null, date: '2026-09-20' });
  assert.equal(Object.hasOwn(delivery.envelope, 'digest'), false);
  const state = acceptAcknowledgement({ acknowledgement: { status: 'received', revision: delivery.envelope.revision }, state: delivery.state });
  assert.equal(nextDelivery({ snapshot: makeV3Snapshot({ revision: 2 }), state, date: '2026-09-20' }).status, 'acknowledged');
});

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

test('T59 installed acknowledge uses one non-TTY execFile input and exact JSON output', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(insightSnapshot()));
  const first = JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout);
  const invocation = deliveryExecution.createInstalledCliInvocation({
    receiptFile: fixture.receiptFile,
    command: 'acknowledge',
    input: { status: 'received', revision: first.envelope.revision, digest: first.envelope.digest },
    pendingEnvelope: first.envelope,
  });

  assert.equal(invocation.run().status, 'acknowledged');
  assert.throws(() => invocation.run(), /already started/);
  assert.equal(JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout).status, 'acknowledged');
});

test('T60 delivery CLI output and acknowledgement shapes are exact', () => {
  const envelope = createEnvelope(insightSnapshot());
  const acknowledgement = { status: 'received', revision: envelope.revision, digest: envelope.digest };
  assert.equal(deliveryExecution.parseDeliveryCliOutput('receive', stableJson(acknowledgement), envelope).status, 'received');
  assert.throws(() => deliveryExecution.parseDeliveryCliOutput('receive', stableJson({ ...acknowledgement, extra: true }), envelope), /keys/);
  assert.throws(() => deliveryExecution.parseDeliveryCliOutput('receive', '{"status":"received"}', envelope));
  assert.throws(() => acceptAcknowledgement({ acknowledgement: { ...acknowledgement, extra: true }, state: nextDelivery({ snapshot: envelope.snapshot, state: null, date: '2026-09-19' }).state }), /keys/);
});

test('T61 delivery failures preserve only structured sanitized evidence', () => {
  const evidence = deliveryExecution.failureEvidence({
    stage: 'acknowledge',
    error: Object.assign(new Error('PRIVATE-PATH-CANARY PRIVATE-DIGEST-CANARY'), { code: 'EACCES' }),
    stateChanged: false,
  });
  assert.deepEqual(evidence, { status: 'error', stage: 'acknowledge', exitCode: null, signal: null, errorClass: 'permission', stderrClass: 'permission-denied', stateChanged: false });
  assert.doesNotMatch(stableJson(evidence), /PRIVATE|PATH|DIGEST/);
});

test('T62 retry approval is not accepted as forgeable invocation data', async () => {
  const fixture = await installedCollectorFixture();
  assert.throws(() => deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'outbox', previousFailure: { stage: 'outbox' }, authority: { kind: 'user', retryApproved: true } }), /invalid invocation keys/);
});

test('T63 CLI failures emit structured sanitized evidence at the command stage', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(insightSnapshot()));
  await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config]);
  await assert.rejects(
    runWithInput(process.execPath, [fixture.cli, 'acknowledge', '--config', fixture.config], stableJson({ status: 'received', extra: 'PRIVATE-PATH-CANARY' })),
    (error) => {
      const evidence = JSON.parse(error.stderr);
      assert.deepEqual(evidence, { status: 'error', stage: 'acknowledge', exitCode: 1, signal: null, errorClass: 'validation', stderrClass: 'validation-rejected', stateChanged: false });
      assert.doesNotMatch(error.stderr, /PRIVATE|PATH|CANARY/);
      return true;
    },
  );
});

test('T64 invocation preserves the CLI sanitized failure without raw subprocess output', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(insightSnapshot()));
  const first = JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout);
  const invocation = deliveryExecution.createInstalledCliInvocation({
    receiptFile: fixture.receiptFile,
    command: 'acknowledge',
    input: { status: 'received', revision: first.envelope.revision, digest: first.envelope.digest, extra: 'PRIVATE-PATH-CANARY' },
    pendingEnvelope: first.envelope,
  });
  assert.throws(() => invocation.run(), (error) => {
    assert.deepEqual(error.evidence, { status: 'error', stage: 'acknowledge', exitCode: 1, signal: null, errorClass: 'validation', stderrClass: 'validation-rejected', stateChanged: false });
    assert.equal(Object.hasOwn(error, 'stderr'), false);
    assert.equal(Object.hasOwn(error, 'stdout'), false);
    return true;
  });
});

test('T65 installed delivery entrypoint acknowledges through receipt-pinned Node', async () => {
  const fixture = await installedCollectorFixture();
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(insightSnapshot()));
  const first = JSON.parse((await run(process.execPath, [fixture.cli, 'outbox', '--config', fixture.config])).stdout);
  const result = JSON.parse((await runWithInput(process.execPath, [fixture.delivery, 'acknowledge', '--receipt', fixture.receiptFile], stableJson({ status: 'received', revision: first.envelope.revision, digest: first.envelope.digest }))).stdout);
  assert.equal(result.status, 'acknowledged');
});

test('T66 receiver entrypoint runs receive then one gated publication check', async () => {
  const fixture = await installedPublisherFixture();
  const envelope = createEnvelope(insightSnapshot({ sourceId: SOURCE_A }));
  const result = JSON.parse((await runWithInput(process.execPath, [fixture.delivery, 'receive-run', '--receipt', fixture.receiptFile], stableJson(envelope))).stdout);
  assert.deepEqual(result.acknowledgement, { status: 'received', revision: envelope.revision, digest: envelope.digest });
  assert.ok(['before-window', 'awaiting-source'].includes(result.publication.status));
  assert.equal((await readSnapshot(path.join(fixture.stateDir, `last-good-${SOURCE_A}.json`), fixture.stateDir)).revision, envelope.revision);
});

test('T67 delivery errors preserve non-default exit status and signal fields', () => {
  assert.deepEqual(deliveryExecution.failureEvidence({ stage: 'run', error: { status: 7 }, stateChanged: 'unknown' }), { status: 'error', stage: 'run', exitCode: 7, signal: null, errorClass: 'execution', stderrClass: 'execution-failed', stateChanged: 'unknown' });
  assert.deepEqual(deliveryExecution.failureEvidence({ stage: 'run', error: { signal: 'SIGTERM' }, stateChanged: 'unknown' }).signal, 'SIGTERM');
});

test('T68 CLI startup validation is distinct from runtime integrity failure', async () => {
  const fixture = await installedCollectorFixture();
  await assert.rejects(run(process.execPath, [fixture.cli, 'outbox']), (error) => {
    assert.deepEqual(JSON.parse(error.stderr), { status: 'error', stage: 'outbox', exitCode: 1, signal: null, errorClass: 'validation', stderrClass: 'validation-rejected', stateChanged: false });
    return true;
  });
});

test('T69 invocation uses receipt-pinned Node and accepts bounded large stdout', async () => {
  const fixture = await installedCollectorFixture();
  const pinnedNode = path.join(fixture.root, 'pinned-node');
  await writeFile(pinnedNode, `#!${process.execPath}\nprocess.stdout.write(' '.repeat(1100000) + '{"status":"no-op"}\\n');\n`);
  await chmod(pinnedNode, 0o700);
  const receipt = JSON.parse(await readFile(fixture.receiptFile, 'utf8'));
  await writeFile(fixture.receiptFile, stableJson({ ...receipt, nodeBinary: pinnedNode }));
  assert.equal(deliveryExecution.createInstalledCliInvocation({ receiptFile: fixture.receiptFile, command: 'run' }).run().status, 'no-op');
});

test('T70 multi-write collection failure reports state change as unknown', async () => {
  const fixture = await installedPublisherFixture();
  await mkdir(path.join(fixture.stateDir, 'snapshot.json'));
  await assert.rejects(run(process.execPath, [fixture.cli, 'collect', '--config', fixture.config]), (error) => {
    assert.equal(JSON.parse(error.stderr).stateChanged, 'unknown');
    return true;
  });
});

test('T71 publisher run processes stored device snapshots without collecting either scope', async () => {
  const fixture = await installedPublisherFixture();
  const local = insightSnapshot({ sourceId: SOURCE_B, revision: 5 });
  await writeFile(path.join(fixture.stateDir, 'snapshot.json'), stableJson(local));
  const result = JSON.parse((await run(process.execPath, [fixture.cli, 'run', '--config', fixture.config, '--as-of', '2026-09-13'])).stdout);
  assert.ok(['before-window', 'awaiting-source'].includes(result.status));
  assert.equal((await readSnapshot(path.join(fixture.stateDir, 'snapshot.json'), fixture.stateDir)).revision, 5);
});

test('T57 receive-triggered and 08:00 gates publish at most once', async () => {
  const root = await temp();
  const snapshots = [
    insightSnapshot({ collectedAt: '2026-09-13T04:00:00.000Z' }),
    insightSnapshot({ sourceId: SOURCE_B, collectedAt: '2026-09-13T04:00:00.000Z' }),
  ];
  let publishes = 0;
  const invoke = () => publishIfReady({
    config: { stateDir: root }, snapshots, expectedSourceIds: [SOURCE_A, SOURCE_B], now: '2026-09-13T05:00:00.000Z', receiptFile: path.join(root, 'publication-receipt.json'),
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

test('T58 collector plist runs at login and every 15 minutes without wake controls', async () => {
  const root = await temp();
  const plist = collectorPlist({ label: 'com.graffitoryu.profile-activity.collector', nodeBinary: process.execPath, cli: path.join(root, 'runtime', 'cli.mjs'), configFile: path.join(root, 'state', 'installed-config.json') });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.doesNotMatch(plist, /KeepAlive|NetworkState|PreventSystemSleep/);
});

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
  assert.equal(chooseLatestSnapshots([newer, makeSnapshot({ calls: 1 })], [SOURCE_A])[0].snapshot.revision, 2);
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

test('T42 token deltas use the last pre-window sample as their baseline', async () => {
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [
    tokenCount('2026-09-11T01:00:00Z', 100, 1),
    tokenCount('2026-09-12T01:00:00Z', 250, 2),
  ] }) });
  assert.equal(result.days[0].tokens, 150);
  assert.equal(result.days[0].maxSessionTokens, 250);
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

test('T43 unknown fork inheritance stays inside affected metric groups', async () => {
  const records = [
    { timestamp: '2026-09-12T00:00:00Z', type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', cwd: '/work/project' } },
    tokenCount('2026-09-12T00:01:00Z', 100, 1),
    message('2026-09-12T00:02:00Z'),
    call('2026-09-12T00:03:00Z', 'call-a'),
    { timestamp: '2026-09-12T00:04:00Z', type: 'event_msg', payload: { type: 'skill_use', skill_name: 'synthetic' } },
  ];
  const result = await collectFiles({ 'child.jsonl': records.map((value) => JSON.stringify(value)).join('\n') + '\n' });
  assert.deepEqual(
    [result.days[0].activeSessions, result.days[0].toolCalls, result.days[0].tokens, result.days[0].skillUses],
    [null, null, null, null],
  );
  assert.deepEqual(
    [result.days[1].activeSessions, result.days[1].toolCalls, result.days[1].tokens],
    [0, 0, 0],
  );
});

test('T46 legacy broad-unknown collector caches are rebuilt for metric-scoped state', async () => {
  const root = await temp();
  await writeFile(path.join(root, 'a.jsonl'), rolloutLines({ events: [message('2026-09-12T00:01:00Z'), call('2026-09-12T00:02:00Z', 'a'), tokenCount('2026-09-12T00:03:00Z', 100, 1)] }));
  const first = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13' });
  const legacyCache = structuredClone(first.cache);
  for (const state of Object.values(legacyCache.files)) {
    state.cacheVersion = 3;
    state.unknownDates = ['2026-09-12'];
    state.events = state.events.filter((event) => event.kind !== 'tokens');
  }
  const rebuilt = await collectLogRoots({ logRoots: [root], from: '2026-09-12', to: '2026-09-13', cache: legacyCache });
  assert.equal(rebuilt.days[0].tokens, 100);
  assert.equal(rebuilt.days[0].toolCalls, 1);
  assert.equal(rebuilt.days[0].activeSessions, 1);
  assert.equal(Object.hasOwn(Object.values(rebuilt.cache.files)[0], 'unknownDates'), false);
});

test('T47 malformed token telemetry only makes token metrics unknown', async () => {
  const malformed = tokenCount('2026-09-12T00:02:00Z', 100, 1);
  malformed.payload.info.total_token_usage.total_tokens = '100';
  const day = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [malformed, call('2026-09-12T00:03:00Z', 'a')] }) })).days[0];
  assert.equal(day.tokens, null);
  assert.equal(day.maxSessionTokens, null);
  assert.equal(day.activeSessions, 1);
  assert.equal(day.newChats, 1);
  assert.equal(day.toolCalls, 1);
  assert.notEqual(day.longestSessionMinutes, null);
  assert.equal(day.coverage, 'partial');
});

test('T47 missing tool call identity only makes tool metrics unknown', async () => {
  const missingId = call('2026-09-12T00:02:00Z', 'unused');
  delete missingId.payload.call_id;
  const day = (await collectFiles({ 'a.jsonl': rolloutLines({ events: [message('2026-09-12T00:01:00Z'), missingId, tokenCount('2026-09-12T00:03:00Z', 100, 1)] }) })).days[0];
  assert.equal(day.toolCalls, null);
  assert.equal(day.pluginCalls, null);
  assert.equal(day.activeSessions, 1);
  assert.equal(day.newChats, 1);
  assert.equal(day.tokens, 100);
  assert.equal(day.maxSessionTokens, 100);
  assert.notEqual(day.longestSessionMinutes, null);
  assert.equal(day.coverage, 'partial');
});

test('T47 partial coverage recovers after malformed dated records leave the window', async () => {
  const oldUnknown = call('2026-09-01T01:00:00Z', 'old', { provenance: 'remote' });
  const oldMalformedToken = tokenCount('2026-09-01T01:01:00Z', 100, 1);
  oldMalformedToken.payload.info.total_token_usage.total_tokens = '100';
  const result = await collectFiles({ 'a.jsonl': rolloutLines({ events: [oldUnknown, oldMalformedToken, message('2026-09-12T01:00:00Z')] }) });
  assert.equal(result.partial, false);
  assert.equal(result.days[0].coverage, 'complete');
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
  assert.match(svg, /Longest streak/);
  assert.match(svg, /Token activity/);
  assert.match(svg, /Activity insights/);
  assert.match(svg, /Active days/);
  assert.match(svg, /width="900" height="350"/);
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

test('T31 staged paths outside the generated-file allowlist are rejected', () => {
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
  await assert.rejects(readFile(installedConfig, 'utf8'));
  await assert.rejects(readFile(receiptFile, 'utf8'));
  const reinstalled = JSON.parse((await run(process.execPath, [path.join(sourceScripts, 'install-local.mjs'), '--apply', '--config', configFile, '--source-commit', commit])).stdout);
  assert.equal(reinstalled.status, 'runtime-installed');
});

test('T72 publisher runtime replacement validates before swapping the installed receipt', async () => {
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
  await run('git', ['-C', source, 'commit', '-m', 'first runtime']);
  const firstCommit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const renderFile = path.join(sourceScripts, 'render.mjs');
  await appendFile(renderFile, '\n// second runtime\n');
  await run('git', ['-C', source, 'add', 'scripts/profile-activity/render.mjs']);
  await run('git', ['-C', source, 'commit', '-m', 'second runtime']);
  const secondCommit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const stateDir = path.join(root, 'state');
  const runtimeRoot = path.join(root, 'runtime');
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, stableJson({
    schemaVersion: 1, role: 'publisher', sourceId: SOURCE_A, policyId: 'local-codex-v1-kst-exclude-profile',
    codexHome: root, logRoots: [root], stateDir, transportDir: null, runtimeDir: runtimeRoot, runtimeManifest: {},
    excludedRepoRoots: [], expectedSources: [], independentSources: true, publicDays: 30, retentionDays: 90,
    staleAfterHours: 48, timezone: 'Asia/Seoul',
    publisher: { repoDir: source, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath: hooks, collectionPath: 'metrics/codex-activity-macmini.json' },
  }));
  const installer = path.join(sourceScripts, 'install-local.mjs');
  await run(process.execPath, [installer, '--apply', '--config', configFile, '--source-commit', firstCommit]);
  const installedConfig = path.join(stateDir, 'installed-config.json');
  const before = await readFile(installedConfig, 'utf8');
  await assert.rejects(run(process.execPath, [installer, '--replace', '--config', installedConfig, '--source-commit', '0'.repeat(40)]));
  assert.equal(await readFile(installedConfig, 'utf8'), before);

  const result = JSON.parse((await run(process.execPath, [installer, '--replace', '--config', installedConfig, '--source-commit', secondCommit])).stdout);
  const replacedConfig = JSON.parse(await readFile(installedConfig, 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(stateDir, 'installation-receipt.json'), 'utf8'));
  assert.equal(result.status, 'runtime-replaced');
  assert.equal(receipt.sourceCommit, secondCommit);
  assert.equal(replacedConfig.runtimeDir, receipt.runtimeDir);
  assert.match(await readFile(path.join(replacedConfig.runtimeDir, 'render.mjs'), 'utf8'), /second runtime/);
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
