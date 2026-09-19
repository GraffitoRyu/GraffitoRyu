import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { aggregateCollections } from '../../scripts/profile-activity/aggregate.mjs';
import { activityCollectionFromSnapshot, canonicalCollection, currentActivityCollections, parseActivityCollection } from '../../scripts/profile-activity/collection.mjs';
import { parseConfig } from '../../scripts/profile-activity/config.mjs';
import { assertOwnedCollectionPaths, publishOwnedCollection, readCandidateCollections } from '../../scripts/profile-activity/publish.mjs';
import { renderActivitySvg } from '../../scripts/profile-activity/render.mjs';
import { stableJson } from '../../scripts/profile-activity/contract.mjs';
import { makeV3Snapshot, SOURCE_A } from './fixtures.mjs';

const run = promisify(execFile);
const day = '2026-09-13';

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), 'profile-direct-'));
}

function collection(calls = 3) {
  return activityCollectionFromSnapshot(makeV3Snapshot({ calls }));
}

async function repository() {
  const root = await temp();
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const hooks = path.join(root, 'hooks');
  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', repo]);
  await run('git', ['-C', repo, 'config', 'user.name', 'Synthetic Test']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await mkdir(path.join(repo, 'metrics'));
  await mkdir(path.join(repo, 'assets'));
  await mkdir(hooks);
  await writeFile(path.join(repo, 'README.md'), 'keep\n');
  await writeFile(path.join(repo, 'metrics/codex-activity.json'), '{"old":true}\n');
  await writeFile(path.join(repo, 'assets/codex-activity.svg'), '<svg>old</svg>\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-m', 'seed']);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  await run('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  await run('git', ['-C', repo, 'config', 'core.hooksPath', hooks]);
  return {
    root,
    remote,
    repo,
    config: {
      role: 'collector',
      stateDir: path.join(root, 'state'),
      publisher: { repoDir: repo, remote, branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 2, hooksPath: hooks, hooksManifest: {}, collectionPath: 'metrics/codex-activity-macmini.json' },
    },
  };
}

async function remoteFile(remote, file) {
  return (await run('git', ['--git-dir', remote, 'show', `main:${file}`], { encoding: 'utf8' })).stdout;
}

function quote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test('public collection is canonical and excludes private routing metadata', () => {
  const value = collection();
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'metricScope', 'timezone', 'window', 'days']);
  const text = canonicalCollection(value);
  for (const forbidden of ['sourceId', 'revision', 'policyId', 'collectedAt', 'digest', 'taskId', 'sessionId']) assert.equal(text.includes(forbidden), false);
  assert.throws(() => parseActivityCollection({ ...value, sourceId: 'forbidden' }), /keys/);
  assert.throws(() => parseActivityCollection({ ...value, days: value.days.slice(1) }), /window/);
});

test('direct publication config has no transport and owns only one fixed collection path', () => {
  const root = path.join(os.tmpdir(), 'profile-direct-config');
  const value = {
    schemaVersion: 1, role: 'collector', sourceId: SOURCE_A, policyId: 'local-codex-v1-kst-exclude-profile', codexHome: root, logRoots: [root], stateDir: path.join(root, 'state'), transportDir: null,
    runtimeDir: path.join(root, 'runtime'), runtimeManifest: {}, excludedRepoRoots: [], expectedSources: [], independentSources: true, publicDays: 30, retentionDays: 90, staleAfterHours: 48, timezone: 'Asia/Seoul',
    publisher: { repoDir: root, remote: 'synthetic', branch: 'main', candidateRoot: path.join(root, 'candidates'), retryLimit: 2, hooksPath: '', hooksManifest: {}, collectionPath: 'metrics/codex-activity-macmini.json' },
  };
  assert.equal(parseConfig(value).publisher.collectionPath, 'metrics/codex-activity-macmini.json');
  assert.throws(() => parseConfig({ ...value, transportDir: path.join(root, 'transport') }), /transport/);
  assert.throws(() => parseConfig({ ...value, publisher: { ...value.publisher, collectionPath: 'metrics/codex-activity-macbook.json/../codex-activity-macmini.json' } }), /collectionPath/);
  assert.doesNotThrow(() => assertOwnedCollectionPaths(['metrics/codex-activity-macmini.json', 'metrics/codex-activity.json'], value.publisher.collectionPath));
  assert.throws(() => assertOwnedCollectionPaths(['metrics/codex-activity-macbook.json'], value.publisher.collectionPath), /allowlist/);
});

test('current collection pair merges without serializing slot identity', () => {
  const values = currentActivityCollections([collection(2), collection(4)], day);
  assert.ok(values);
  const activity = aggregateCollections(values, { asOfDate: day, referenceTime: '2026-09-13T09:00:00.000Z', staleAfterHours: 48 });
  assert.equal(activity.schemaVersion, 3);
  assert.equal(activity.aggregation, 'sum');
  assert.equal(JSON.stringify(activity).includes('public-collection-'), false);
});

test('owned collection publish preserves final files when peer is missing', async () => {
  const fixture = await repository();
  const result = await publishOwnedCollection(fixture.config, collection(), { buildFinal: async () => null });
  assert.equal(result.status, 'published');
  assert.equal(await remoteFile(fixture.remote, 'README.md'), 'keep\n');
  assert.equal(await remoteFile(fixture.remote, 'metrics/codex-activity.json'), '{"old":true}\n');
  assert.equal(await remoteFile(fixture.remote, 'assets/codex-activity.svg'), '<svg>old</svg>\n');
  assert.equal(await remoteFile(fixture.remote, 'metrics/codex-activity-macmini.json'), canonicalCollection(collection()));
  await assert.rejects(remoteFile(fixture.remote, 'metrics/codex-activity-macbook.json'));
});

test('final build failures stop without publishing the owned collection', async () => {
  const fixture = await repository();
  await writeFile(path.join(fixture.repo, 'metrics/codex-activity-macbook.json'), canonicalCollection(collection(2)));
  await run('git', ['-C', fixture.repo, 'add', 'metrics/codex-activity-macbook.json']);
  await run('git', ['-C', fixture.repo, 'commit', '-m', 'seed peer']);
  await run('git', ['-C', fixture.repo, 'push', 'origin', 'main']);
  const before = (await run('git', ['--git-dir', fixture.remote, 'rev-parse', 'main'])).stdout.trim();
  await assert.rejects(publishOwnedCollection(fixture.config, collection(4), { buildFinal: async () => { throw new Error('renderer defect'); } }), /publish candidate failed/);
  assert.equal((await run('git', ['--git-dir', fixture.remote, 'rev-parse', 'main'])).stdout.trim(), before);
  await assert.rejects(remoteFile(fixture.remote, 'metrics/codex-activity-macmini.json'));
});

test('owned collection publish merges the current pair into deterministic final files', async () => {
  const fixture = await repository();
  await writeFile(path.join(fixture.repo, 'metrics/codex-activity-macbook.json'), canonicalCollection(collection(2)));
  await run('git', ['-C', fixture.repo, 'add', 'metrics/codex-activity-macbook.json']);
  await run('git', ['-C', fixture.repo, 'commit', '-m', 'seed peer']);
  await run('git', ['-C', fixture.repo, 'push', 'origin', 'main']);
  const result = await publishOwnedCollection(fixture.config, collection(4), {
    buildFinal: async (values) => {
      const current = currentActivityCollections(values, day);
      if (current === null) return null;
      const activity = aggregateCollections(current, { asOfDate: day, referenceTime: '2026-09-13T09:00:00.000Z', staleAfterHours: 48 });
      return { 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) };
    },
  });
  assert.equal(result.status, 'published');
  const final = JSON.parse(await remoteFile(fixture.remote, 'metrics/codex-activity.json'));
  assert.equal(final.schemaVersion, 3);
  assert.equal(final.aggregation, 'sum');
  assert.match(await remoteFile(fixture.remote, 'assets/codex-activity.svg'), /Codex activity silhouette/);
});

test('non-fast-forward retry rereads the peer collection before generating final files', async () => {
  const fixture = await repository();
  const peer = path.join(fixture.root, 'peer.json');
  const competing = path.join(fixture.root, 'competing');
  const marker = path.join(fixture.root, 'hook-ran');
  await writeFile(peer, canonicalCollection(collection(2)));
  const hook = `#!/bin/sh\nunset $(git rev-parse --local-env-vars)\nif [ ! -f ${quote(marker)} ]; then\n  : > ${quote(marker)}\n  git clone ${quote(fixture.remote)} ${quote(competing)} >/dev/null 2>&1\n  git -C ${quote(competing)} config user.name Synthetic\n  git -C ${quote(competing)} config user.email synthetic@example.invalid\n  mkdir -p ${quote(path.join(competing, 'metrics'))}\n  cp ${quote(peer)} ${quote(path.join(competing, 'metrics/codex-activity-macbook.json'))}\n  git -C ${quote(competing)} add metrics/codex-activity-macbook.json\n  git -C ${quote(competing)} commit -m peer >/dev/null\n  git -C ${quote(competing)} push origin main >/dev/null\nfi\n`;
  const hookFile = path.join(fixture.config.publisher.hooksPath, 'pre-push');
  await writeFile(hookFile, hook);
  await chmod(hookFile, 0o700);
  fixture.config.publisher.hooksManifest['pre-push'] = { digest: createHash('sha256').update(hook).digest('hex'), mode: 0o700 };
  let builds = 0;
  const result = await publishOwnedCollection(fixture.config, collection(4), {
    buildFinal: async (values) => {
      builds += 1;
      const current = currentActivityCollections(values, day);
      if (current === null) return null;
      const activity = aggregateCollections(current, { asOfDate: day, referenceTime: '2026-09-13T09:00:00.000Z', staleAfterHours: 48 });
      return { 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) };
    },
  });
  assert.equal(result.status, 'published');
  const inspection = path.join(fixture.root, 'inspection');
  await run('git', ['clone', fixture.remote, inspection]);
  await readCandidateCollections(inspection);
  assert.equal(builds, 1);
  assert.equal(JSON.parse(await remoteFile(fixture.remote, 'metrics/codex-activity.json')).schemaVersion, 3);
  assert.equal(await remoteFile(fixture.remote, 'metrics/codex-activity-macbook.json'), canonicalCollection(collection(2)));
  assert.equal(await remoteFile(fixture.remote, 'metrics/codex-activity-macmini.json'), canonicalCollection(collection(4)));
});
