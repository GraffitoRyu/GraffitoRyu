import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { parsePrivateSnapshot, stableJson } from './contract.mjs';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

async function assertContained(candidate, parent) {
  const resolvedParent = await realpath(parent);
  const resolvedCandidateParent = await realpath(path.dirname(candidate));
  if (resolvedCandidateParent !== resolvedParent && !resolvedCandidateParent.startsWith(`${resolvedParent}${path.sep}`)) throw new Error('path escaped private scope');
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('snapshot symlink refused');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function prepareWriteTarget(file, scope = path.dirname(file)) {
  const normalizedScope = path.resolve(scope);
  const normalizedFile = path.resolve(file);
  if (normalizedFile !== normalizedScope && !normalizedFile.startsWith(`${normalizedScope}${path.sep}`)) throw new Error('write path escaped scope');
  await mkdir(normalizedScope, { recursive: true, mode: 0o700 });
  const root = await realpath(normalizedScope);
  let parent = root;
  const relativeParent = path.relative(normalizedScope, path.dirname(normalizedFile));
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('write parent is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(parent, { mode: 0o700 });
    }
  }
  const target = path.join(parent, path.basename(normalizedFile));
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('write target is not a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function readSnapshot(file, scope = path.dirname(file)) {
  if (/\.tmp(?:\.|$)|conflicted copy/i.test(path.basename(file))) throw new Error('temporary snapshot refused');
  await assertContained(file, scope);
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) throw new Error('invalid snapshot file');
  return parsePrivateSnapshot(JSON.parse(await readFile(file, 'utf8')));
}

export async function atomicWrite(file, value, scope = path.dirname(file)) {
  const target = await prepareWriteTarget(file, scope);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(typeof value === 'string' ? value : stableJson(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export function snapshotDigest(snapshot) {
  return createHash('sha256').update(stableJson(parsePrivateSnapshot(snapshot))).digest('hex');
}

export function chooseLatestSnapshots(snapshots, expectedSourceIds) {
  const expected = new Set(expectedSourceIds);
  const selected = new Map();
  for (const input of snapshots) {
    const bound = input?.snapshot !== undefined;
    if (bound && Object.keys(input).sort().join(',') !== 'snapshot,sourceId') throw new Error('invalid source binding');
    const snapshot = parsePrivateSnapshot(bound ? input.snapshot : input);
    const sourceId = bound ? input.sourceId : snapshot.sourceId;
    if (!expected.has(sourceId) || snapshot.schemaVersion === 3 && !bound) throw new Error('unregistered source');
    if (snapshot.schemaVersion !== 3 && bound && snapshot.sourceId !== sourceId) throw new Error('source binding mismatch');
    const current = selected.get(sourceId);
    if (!current || snapshot.revision > current.snapshot.revision) selected.set(sourceId, { sourceId, snapshot });
    else if (snapshot.revision === current.snapshot.revision && snapshotDigest(snapshot) !== snapshotDigest(current.snapshot)) throw new Error('snapshot revision conflict');
  }
  return expectedSourceIds.map((id) => selected.get(id)).filter(Boolean);
}

export async function saveAndExportSnapshot({ snapshot, localFile, localScope, exportFile, exportScope }) {
  const parsed = parsePrivateSnapshot(snapshot);
  await atomicWrite(localFile, parsed, localScope);
  let delivery = 'local-only';
  if (exportFile) {
    try {
      await atomicWrite(exportFile, parsed, exportScope);
      delivery = 'delivery-pending';
    } catch {
      delivery = 'delivery-pending';
    }
  }
  return { snapshot: parsed, digest: snapshotDigest(parsed), delivery };
}

export async function isReadable(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
