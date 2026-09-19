import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, prepareWriteTarget } from './snapshot.mjs';
import { collectionPath, createRepositoryCollection } from './collection.mjs';
import { stableJson } from './contract.mjs';
import { repositoryCollectionDecision } from './publication-gate.mjs';
import { processActivitySurface } from './account-usage.mjs';
import { renderActivitySvg } from './render.mjs';

const run = promisify(execFile);
export const GENERATED_PATHS = ['assets/codex-activity.svg', 'metrics/codex-activity.json'];

async function git(repo, args) {
  const { stdout } = await run('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

export async function capturePublisherHooks(repo) {
  const configured = await git(repo, ['rev-parse', '--git-path', 'hooks']);
  const root = path.isAbsolute(configured) ? configured : path.resolve(repo, configured);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('invalid Git hooks directory');
  const manifest = {};
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Git hook symlink refused');
      if (info.isDirectory()) await visit(file, relative);
      else if (info.isFile()) manifest[relative] = { digest: createHash('sha256').update(await readFile(file)).digest('hex'), mode: info.mode & 0o777 };
      else throw new Error('invalid Git hook entry');
    }
  }
  await visit(root);
  return manifest;
}

export async function verifyPublisherHooks(repo, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Git hooks manifest required');
  const actual = await capturePublisherHooks(repo);
  const names = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) throw new Error('Git hooks changed');
  for (const name of names) {
    if (actual[name].digest !== expected[name]?.digest || actual[name].mode !== expected[name]?.mode) throw new Error('Git hooks changed');
  }
}

export async function withPublisherLock(lockRoot, action) {
  const lock = path.join(lockRoot, 'publisher.lock');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return { status: 'skipped-lock' };
    throw error;
  }
  try {
    await writeFile(path.join(lock, 'owner'), `${process.pid}\n`, { mode: 0o600 });
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

export function assertAllowedPaths(paths, allowed = GENERATED_PATHS) {
  const unique = [...new Set(paths)].sort();
  if (unique.some((item) => !allowed.includes(item))) throw new Error('publish path outside allowlist');
}

export async function verifyRuntimeManifest(runtimeDir, manifest) {
  if (!manifest || Object.keys(manifest).length === 0) throw new Error('runtime manifest required');
  const root = await realpath(runtimeDir);
  for (const [relative, expected] of Object.entries(manifest)) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..') || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('invalid runtime manifest');
    const candidate = path.join(root, relative);
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('invalid runtime file');
    const file = await realpath(candidate);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('runtime path escaped');
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual !== expected) throw new Error('runtime digest mismatch');
  }
}

export async function validatePublisherTarget(config) {
  if (!config.publisher || !(config.role === 'publisher' || config.role === 'collector' && config.collectionSlot === 'macbook')) throw new Error('publisher role required');
  const repo = await realpath(config.publisher.repoDir);
  if (await git(repo, ['rev-parse', '--show-toplevel']) !== repo) throw new Error('invalid publisher repository');
  const remote = await git(repo, ['remote', 'get-url', '--push', 'origin']);
  if (remote !== config.publisher.remote) throw new Error('publisher remote mismatch');
  const hooksPath = await git(repo, ['config', '--get', 'core.hooksPath']).catch(() => '');
  if ((config.publisher.hooksPath ?? '') !== hooksPath) throw new Error('Git hooks changed');
  await verifyPublisherHooks(repo, config.publisher.hooksManifest);
  return repo;
}

async function writeGenerated(candidate, generated) {
  for (const relative of Object.keys(generated)) await prepareWriteTarget(path.join(candidate, relative), candidate);
  for (const relative of Object.keys(generated)) {
    const target = path.join(candidate, relative);
    await atomicWrite(target, generated[relative], candidate);
  }
}

async function publishFilesUnlocked(config, prepare, allowed, { dryRun = false } = {}) {
  const repo = await validatePublisherTarget(config);
  if (dryRun) return { status: 'dry-run', paths: allowed };
  const attempts = Math.min(3, (config.publisher.retryLimit ?? 2) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = path.join(config.publisher.candidateRoot, `candidate-${randomUUID()}`);
    let committed = false;
    let nonFastForward = false;
    try {
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['fetch', 'origin', config.publisher.branch]);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['worktree', 'add', '--detach', candidate, `origin/${config.publisher.branch}`]);
      const generated = await prepare(candidate);
      assertAllowedPaths(Object.keys(generated), allowed);
      await writeGenerated(candidate, generated);
      await git(candidate, ['add', '--', ...Object.keys(generated)]);
      const staged = (await git(candidate, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      assertAllowedPaths(staged, allowed);
      if (staged.length === 0) {
        await git(repo, ['worktree', 'remove', candidate]);
        return { status: 'no-op' };
      }
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['commit', '-m', 'chore(profile): refresh activity metrics']);
      committed = true;
      const commit = await git(candidate, ['rev-parse', 'HEAD']);
      assertAllowedPaths((await git(candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').filter(Boolean), allowed);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      try {
        await git(candidate, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${config.publisher.branch}`]);
      } catch (error) {
        nonFastForward = /\[(?:rejected|remote rejected)\].*\((?:non-fast-forward|fetch first|failed to update ref|incorrect old value provided)\)/.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        throw error;
      }
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['fetch', 'origin', config.publisher.branch]);
      await git(candidate, ['merge-base', '--is-ancestor', commit, `origin/${config.publisher.branch}`]);
      await git(repo, ['worktree', 'remove', candidate]);
      return { status: 'published', commit };
    } catch (error) {
      lastError = new Error(committed ? 'publish failed after candidate commit' : 'publish candidate failed');
      if (!nonFastForward) throw lastError;
      if (attempt + 1 < attempts) await git(repo, ['worktree', 'remove', candidate]);
    }
  }
  throw lastError;
}

export async function publishGeneratedUnlocked(config, generated, options = {}) {
  if (config.role !== 'publisher') throw new Error('publisher role required');
  return publishFilesUnlocked(config, async () => generated, GENERATED_PATHS, options);
}

export async function publishCollection(config, input, options = {}) {
  const collection = createRepositoryCollection(input);
  const ownPath = collectionPath(config.collectionSlot);
  if (config.collectionSlot === 'macmini' && config.role !== 'publisher') throw new Error('renderer role required');
  const allowed = [ownPath, ...(config.collectionSlot === 'macmini' ? GENERATED_PATHS : [])];
  const now = options.now ?? new Date().toISOString();
  const prepare = async (candidate) => {
    const generated = { [ownPath]: stableJson(collection) };
    if (config.collectionSlot !== 'macmini') return generated;
    const decision = await repositoryCollectionDecision({ repo: candidate, collection, now, staleAfterHours: config.staleAfterHours });
    if (decision.status !== 'ready') return generated;
    const { activity } = processActivitySurface(decision.snapshots, {
      asOfDate: decision.date, referenceTime: now, expectedSourceIds: ['macbook', 'macmini'], independentSources: config.independentSources, staleAfterHours: config.staleAfterHours,
    }, options.accountUsage ?? null);
    if (activity.status === 'unavailable') return generated;
    return { ...generated, 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) };
  };
  const publish = () => publishFilesUnlocked(config, prepare, allowed, options);
  return options.dryRun ? publish() : withPublisherLock(config.stateDir, publish);
}

export async function publishGenerated(config, generated, options = {}) {
  if (options.dryRun) return publishGeneratedUnlocked(config, generated, options);
  return withPublisherLock(config.stateDir, () => publishGeneratedUnlocked(config, generated, options));
}
