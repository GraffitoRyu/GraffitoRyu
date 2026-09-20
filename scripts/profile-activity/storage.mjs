import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { stableJson } from './contract.mjs';

export async function prepareWriteTarget(file, scope = path.dirname(file)) {
  const normalizedScope = path.resolve(scope);
  const normalizedFile = path.resolve(file);
  if (normalizedFile !== normalizedScope && !normalizedFile.startsWith(`${normalizedScope}${path.sep}`)) throw new Error('write path escaped scope');
  await mkdir(normalizedScope, { recursive: true, mode: 0o700 });
  const root = await realpath(normalizedScope);
  let parent = root;
  for (const part of path.relative(normalizedScope, path.dirname(normalizedFile)).split(path.sep).filter(Boolean)) {
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
