import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizeAccountUsageResponse } from '../../scripts/profile-activity/app-server-usage.mjs';
import { parseConfig } from '../../scripts/profile-activity/config.mjs';
import { addDays, parsePublicActivity, stableJson } from '../../scripts/profile-activity/contract.mjs';
import { failureEvidence, parseRunOutput } from '../../scripts/profile-activity/execution.mjs';
import { assertAllowedPaths, publishGenerated, verifyRuntimeManifest, withPublisherLock } from '../../scripts/profile-activity/publish.mjs';
import { renderActivitySvg } from '../../scripts/profile-activity/render.mjs';
import { atomicWrite } from '../../scripts/profile-activity/storage.mjs';

const run = promisify(execFile);

function activity() {
  const from = '2026-08-22';
  const days = Array.from({ length: 30 }, (_, index) => ({ date: addDays(from, index), tokens: (index + 1) * 10 }));
  return {
    schemaVersion: 6,
    metricScope: 'codex-account-token-activity',
    timezone: 'Asia/Seoul',
    window: { from, to: '2026-09-20' },
    asOfDate: '2026-09-20',
    summary: { lifetimeTokens: 41126977768, peakDailyTokens: 1067831636, longestRunningTurnSec: 59711, currentStreakDays: 35, longestStreakDays: 35 },
    days,
  };
}

function config(root) {
  return {
    schemaVersion: 2,
    codexBinary: path.join(root, 'codex'),
    stateDir: path.join(root, 'state'),
    runtimeDir: path.join(root, 'runtime'),
    runtimeManifest: {},
    timezone: 'Asia/Seoul',
    publisher: { repoDir: root, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 2, hooksPath: '', hooksManifest: {} },
  };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-account-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const hooks = path.join(root, 'hooks');
  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', repo]);
  await run('git', ['-C', repo, 'config', 'user.name', 'Synthetic Test']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await mkdir(path.join(repo, 'assets'));
  await mkdir(path.join(repo, 'metrics'));
  await mkdir(hooks);
  await writeFile(path.join(repo, 'README.md'), 'keep\n');
  await writeFile(path.join(repo, 'assets/codex-activity.svg'), 'old\n');
  await writeFile(path.join(repo, 'assets/codex-activity-ko.svg'), 'old\n');
  await writeFile(path.join(repo, 'metrics/codex-activity.json'), '{}\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-m', 'seed']);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  await run('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  await run('git', ['-C', repo, 'config', 'core.hooksPath', hooks]);
  return { root, remote, repo, hooks };
}

test('public schema accepts only complete App Server token activity', () => {
  assert.deepEqual(parsePublicActivity(activity()), activity());
  assert.throws(() => parsePublicActivity({ ...activity(), unexpected: {} }), /keys/);
  assert.throws(() => parsePublicActivity({ ...activity(), days: activity().days.slice(1) }), /30 entries/);
  assert.throws(() => parsePublicActivity({ ...activity(), summary: { ...activity().summary, lifetimeTokens: null } }), /lifetimeTokens/);
});

test('App Server response is reduced without retaining arbitrary fields', () => {
  const sample = activity();
  const result = sanitizeAccountUsageResponse({ summary: { ...sample.summary, account: 'PRIVATE' }, dailyUsageBuckets: sample.days.map((day) => ({ startDate: day.date, tokens: day.tokens, thread: 'PRIVATE' })), credential: 'PRIVATE' }, sample.window);
  assert.deepEqual(result, sample);
  assert.doesNotMatch(stableJson(result), /PRIVATE|thread|credential/);
});

test('English and Korean SVGs share verified values, layout, and theme opacity', () => {
  const english = renderActivitySvg(activity());
  const korean = renderActivitySvg(activity(), 'ko');
  for (const value of ['41.13B', '1.07B', '16h 35m', '35d', 'Daily account tokens']) assert.match(english, new RegExp(value.replace('.', '\\.')));
  for (const value of ['411.27억', '10.68억', '16시간 35분', '일별 계정 토큰']) assert.match(korean, new RegExp(value.replace('.', '\\.')));
  for (const svg of [english, korean]) {
    assert.match(svg, /width="900" height="410"/);
    assert.match(svg, /fill-opacity:\.02/);
    assert.match(svg, /fill-opacity:\.36/);
    assert.doesNotMatch(svg, /Unavailable|Not observed|Plugin|Skill|Analytics/);
  }
});

test('config contains only App Server runtime and publisher fields', () => {
  const root = path.join(os.tmpdir(), 'profile-config');
  assert.deepEqual(parseConfig(config(root)), config(root));
  assert.throws(() => parseConfig({ ...config(root), unexpected: null }), /keys/);
});

test('publication output accepts only the JSON and two SVGs', () => {
  assert.doesNotThrow(() => assertAllowedPaths(['metrics/codex-activity.json', 'assets/codex-activity.svg', 'assets/codex-activity-ko.svg']));
  assert.throws(() => assertAllowedPaths(['README.md']), /allowlist/);
  assert.throws(() => assertAllowedPaths(['metrics/unexpected.json']), /allowlist/);
});

test('publisher lock permits one concurrent writer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-lock-'));
  let release;
  const first = withPublisherLock(root, () => new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await withPublisherLock(root, async () => ({ status: 'unexpected' })), { status: 'skipped-lock' });
  release({ status: 'done' });
  assert.deepEqual(await first, { status: 'done' });
});

test('atomic writes refuse a symlink target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-write-'));
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'keep');
  await symlink(outside, path.join(root, 'target'));
  await assert.rejects(atomicWrite(path.join(root, 'target'), 'changed', root), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('runtime manifest rejects changed source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-runtime-'));
  await writeFile(path.join(root, 'runtime.mjs'), 'export default 1;\n');
  const digest = createHash('sha256').update('export default 1;\n').digest('hex');
  await verifyRuntimeManifest(root, { 'runtime.mjs': digest });
  await writeFile(path.join(root, 'runtime.mjs'), 'export default 2;\n');
  await assert.rejects(verifyRuntimeManifest(root, { 'runtime.mjs': digest }), /digest/);
});

test('committed runtime installs and removes through its verified receipt', async () => {
  const repo = path.resolve(import.meta.dirname, '../..');
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-install-'));
  const stateDir = path.join(root, 'state');
  const configFile = path.join(root, 'config.json');
  const sourceCommit = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  const remote = (await run('git', ['-C', repo, 'remote', 'get-url', '--push', 'origin'], { encoding: 'utf8' })).stdout.trim();
  const hooksPath = (await run('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))).stdout.trim();
  await writeFile(configFile, stableJson({ schemaVersion: 2, codexBinary: process.execPath, stateDir, runtimeDir: path.join(root, 'runtimes'), runtimeManifest: {}, timezone: 'Asia/Seoul', publisher: { repoDir: repo, remote, branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 0, hooksPath, hooksManifest: {} } }));
  const installer = path.join(repo, 'scripts/profile-activity/install-local.mjs');
  assert.match((await run(process.execPath, [installer, '--apply', '--config', configFile, '--source-commit', sourceCommit], { encoding: 'utf8' })).stdout, /runtime-installed/);
  const installedConfig = path.join(stateDir, 'installed-config.json');
  assert.match((await run(process.execPath, [installer, '--remove', '--config', installedConfig], { encoding: 'utf8' })).stdout, /runtime-removed/);
});

test('installed execution accepts only terminal run statuses', () => {
  assert.deepEqual(parseRunOutput('{"status":"no-op"}'), { status: 'no-op' });
  assert.deepEqual(parseRunOutput('{"status":"published","commit":"0123456789012345678901234567890123456789"}'), { status: 'published', commit: '0123456789012345678901234567890123456789' });
  assert.throws(() => parseRunOutput('{"status":"awaiting-source"}'), /status/);
  assert.equal(failureEvidence({ stage: 'run', error: new Error('account token usage unavailable') }).errorClass, 'validation');
});

test('publisher updates only generated files from the newest remote branch', async () => {
  const fixture = await repository();
  const value = activity();
  const generated = { 'metrics/codex-activity.json': stableJson(value), 'assets/codex-activity.svg': renderActivitySvg(value), 'assets/codex-activity-ko.svg': renderActivitySvg(value, 'ko') };
  const result = await publishGenerated({ stateDir: path.join(fixture.root, 'state'), publisher: { repoDir: fixture.repo, remote: fixture.remote, branch: 'main', candidateRoot: path.join(fixture.root, 'candidates'), retryLimit: 0, hooksPath: fixture.hooks, hooksManifest: {} } }, generated);
  assert.equal(result.status, 'published');
  assert.equal((await run('git', ['--git-dir', fixture.remote, 'show', 'main:README.md'], { encoding: 'utf8' })).stdout, 'keep\n');
  assert.deepEqual(JSON.parse((await run('git', ['--git-dir', fixture.remote, 'show', 'main:metrics/codex-activity.json'], { encoding: 'utf8' })).stdout), value);
});

test('tracked public artifacts match the renderer and contain no legacy fields', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const value = parsePublicActivity(JSON.parse(await readFile(path.join(root, 'metrics/codex-activity.json'), 'utf8')));
  assert.equal(await readFile(path.join(root, 'assets/codex-activity.svg'), 'utf8'), renderActivitySvg(value));
  assert.equal(await readFile(path.join(root, 'assets/codex-activity-ko.svg'), 'utf8'), renderActivitySvg(value, 'ko'));
  assert.doesNotMatch(stableJson(value), /PRIVATE_CANARY/);
});
