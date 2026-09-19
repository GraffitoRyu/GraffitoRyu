import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalCollection, COLLECTION_PATHS, parseActivityCollection } from './collection.mjs';
import { atomicWrite, prepareWriteTarget } from './snapshot.mjs';

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

export function assertAllowedPaths(paths) {
  const unique = [...new Set(paths)].sort();
  if (unique.some((item) => !GENERATED_PATHS.includes(item))) throw new Error('publish path outside allowlist');
}

export function assertOwnedCollectionPaths(paths, collectionPath) {
  if (!COLLECTION_PATHS.includes(collectionPath)) throw new Error('invalid collection path');
  const allowed = new Set([collectionPath, ...GENERATED_PATHS]);
  if ([...new Set(paths)].some((item) => !allowed.has(item))) throw new Error('publish path outside owned allowlist');
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

export async function validatePublisherTarget(config, { allowCollector = false } = {}) {
  if ((!allowCollector && config.role !== 'publisher') || !config.publisher) throw new Error('publisher role required');
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
  for (const relative of GENERATED_PATHS) await prepareWriteTarget(path.join(candidate, relative), candidate);
  for (const relative of GENERATED_PATHS) {
    const target = path.join(candidate, relative);
    await atomicWrite(target, generated[relative], candidate);
  }
}

export async function publishGeneratedUnlocked(config, generated, { dryRun = false } = {}) {
  const repo = await validatePublisherTarget(config);
  if (dryRun) return { status: 'dry-run', paths: GENERATED_PATHS };
  const attempts = Math.min(3, (config.publisher.retryLimit ?? 2) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = path.join(config.publisher.candidateRoot, `candidate-${randomUUID()}`);
    let committed = false;
    try {
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['fetch', 'origin', config.publisher.branch]);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['worktree', 'add', '--detach', candidate, `origin/${config.publisher.branch}`]);
      await writeGenerated(candidate, generated);
      await git(candidate, ['add', '--', ...GENERATED_PATHS]);
      const staged = (await git(candidate, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      assertAllowedPaths(staged);
      if (staged.length === 0) {
        await git(repo, ['worktree', 'remove', candidate]);
        return { status: 'no-op' };
      }
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['commit', '-m', 'chore(profile): refresh activity metrics']);
      committed = true;
      const commit = await git(candidate, ['rev-parse', 'HEAD']);
      assertAllowedPaths((await git(candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').filter(Boolean));
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['push', 'origin', `HEAD:refs/heads/${config.publisher.branch}`]);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['fetch', 'origin', config.publisher.branch]);
      await git(candidate, ['merge-base', '--is-ancestor', commit, `origin/${config.publisher.branch}`]);
      await git(repo, ['worktree', 'remove', candidate]);
      return { status: 'published', commit };
    } catch (error) {
      lastError = new Error(committed ? 'publish failed after candidate commit' : 'publish candidate failed');
    }
  }
  throw lastError;
}

export async function publishGenerated(config, generated, options = {}) {
  if (options.dryRun) return publishGeneratedUnlocked(config, generated, options);
  return withPublisherLock(config.stateDir, () => publishGeneratedUnlocked(config, generated, options));
}

async function readCanonicalCollection(file) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error('invalid public collection file');
  const text = await readFile(file, 'utf8');
  const parsed = parseActivityCollection(JSON.parse(text));
  if (text !== canonicalCollection(parsed)) throw new Error('non-canonical public collection');
  return parsed;
}

export async function readCandidateCollections(candidate, { ownedPath = null, referenceTime = null, staleAfterHours = null } = {}) {
  const collections = await Promise.all(COLLECTION_PATHS.map((relative) => readCanonicalCollection(path.join(candidate, relative))));
  if (referenceTime !== null) {
    const now = new Date(referenceTime);
    if (Number.isNaN(now.valueOf()) || !Number.isSafeInteger(staleAfterHours) || staleAfterHours < 1) throw new Error('invalid collection freshness options');
    for (const relative of COLLECTION_PATHS.filter((item) => item !== ownedPath)) {
      const committedAt = new Date(await git(candidate, ['log', '-1', '--format=%cI', '--', relative]));
      if (Number.isNaN(committedAt.valueOf()) || committedAt - now > 5 * 60 * 1000 || now - committedAt > staleAfterHours * 3600000) return null;
    }
  }
  return collections;
}

async function eligibleCandidateCollections(candidate, options) {
  try {
    return await readCandidateCollections(candidate, options);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || /invalid (?:public|activity|private)|non-canonical public collection|incomplete days window|keys/.test(error.message)) return null;
    throw error;
  }
}

async function publishOwnedCollectionUnlocked(config, collection, { buildFinal, referenceTime = null } = {}) {
  const repo = await validatePublisherTarget(config, { allowCollector: true });
  const owned = config.publisher.collectionPath;
  assertOwnedCollectionPaths([], owned);
  const canonical = canonicalCollection(collection);
  const attempts = Math.min(3, (config.publisher.retryLimit ?? 2) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = path.join(config.publisher.candidateRoot, `candidate-${randomUUID()}`);
    let added = false;
    let committed = false;
    try {
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['fetch', 'origin', config.publisher.branch]);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(repo, ['worktree', 'add', '--detach', candidate, `origin/${config.publisher.branch}`]);
      added = true;
      const ownedFile = path.join(candidate, owned);
      try {
        const previous = await readCanonicalCollection(ownedFile);
        if (previous.window.to > collection.window.to) throw new Error('collection rollback');
      } catch (error) {
        if (error.code !== 'ENOENT' && !/invalid public collection|non-canonical public collection|Unexpected token/.test(error.message)) throw error;
      }
      await atomicWrite(ownedFile, canonical, candidate);
      let finalGenerated = null;
      if (buildFinal) {
        const collections = await eligibleCandidateCollections(candidate, { ownedPath: owned, referenceTime, staleAfterHours: config.staleAfterHours });
        if (collections !== null) finalGenerated = await buildFinal(collections);
      }
      if (finalGenerated !== null) {
        if (!finalGenerated || Object.keys(finalGenerated).sort().join(',') !== [...GENERATED_PATHS].sort().join(',')) throw new Error('invalid final generated paths');
        await writeGenerated(candidate, finalGenerated);
      }
      await git(candidate, ['add', '--', owned, ...GENERATED_PATHS]);
      const staged = (await git(candidate, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      assertOwnedCollectionPaths(staged, owned);
      if (staged.length === 0) return { status: 'no-op' };
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['commit', '-m', 'chore(profile): refresh activity collection']);
      committed = true;
      const commit = await git(candidate, ['rev-parse', 'HEAD']);
      assertOwnedCollectionPaths((await git(candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').filter(Boolean), owned);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['push', 'origin', `HEAD:refs/heads/${config.publisher.branch}`]);
      await verifyPublisherHooks(repo, config.publisher.hooksManifest);
      await git(candidate, ['fetch', 'origin', config.publisher.branch]);
      await git(candidate, ['merge-base', '--is-ancestor', commit, `origin/${config.publisher.branch}`]);
      return { status: 'published', commit };
    } catch (error) {
      lastError = new Error(committed ? 'publish failed after candidate commit' : 'publish candidate failed');
    } finally {
      if (added) await git(repo, ['worktree', 'remove', '--force', candidate]).catch(() => {});
    }
  }
  throw lastError;
}

export async function publishOwnedCollection(config, collection, options = {}) {
  return withPublisherLock(config.stateDir, () => publishOwnedCollectionUnlocked(config, collection, options));
}
