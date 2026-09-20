import path from 'node:path';
import { readFile } from 'node:fs/promises';

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`invalid ${name}`);
  return path.normalize(value);
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`invalid ${name} keys`);
}

export function parseConfig(value) {
  exactKeys(value, ['schemaVersion', 'codexBinary', 'stateDir', 'runtimeDir', 'runtimeManifest', 'timezone', 'publisher'], 'config');
  if (value.schemaVersion !== 2 || value.timezone !== 'Asia/Seoul') throw new Error('invalid config identity');
  if (!value.runtimeManifest || typeof value.runtimeManifest !== 'object' || Array.isArray(value.runtimeManifest) || Object.entries(value.runtimeManifest).some(([name, digest]) => path.isAbsolute(name) || name.split(path.sep).includes('..') || !/^[0-9a-f]{64}$/.test(digest))) throw new Error('invalid runtimeManifest');
  exactKeys(value.publisher, ['repoDir', 'remote', 'branch', 'candidateRoot', 'retryLimit', 'hooksPath', 'hooksManifest'], 'publisher');
  if (typeof value.publisher.remote !== 'string' || typeof value.publisher.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.publisher.branch) || value.publisher.branch.includes('..') || !Number.isSafeInteger(value.publisher.retryLimit) || value.publisher.retryLimit < 0 || value.publisher.retryLimit > 2 || typeof value.publisher.hooksPath !== 'string' || (value.publisher.hooksPath !== '' && !path.isAbsolute(value.publisher.hooksPath))) throw new Error('invalid publisher');
  if (!value.publisher.hooksManifest || typeof value.publisher.hooksManifest !== 'object' || Array.isArray(value.publisher.hooksManifest)) throw new Error('invalid hooksManifest');
  for (const [name, entry] of Object.entries(value.publisher.hooksManifest)) {
    if (!name || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('invalid hook path');
    exactKeys(entry, ['digest', 'mode'], 'hook entry');
    if (!/^[0-9a-f]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('invalid hook entry');
  }
  return {
    ...value,
    codexBinary: absolute(value.codexBinary, 'codexBinary'),
    stateDir: absolute(value.stateDir, 'stateDir'),
    runtimeDir: absolute(value.runtimeDir, 'runtimeDir'),
    publisher: { ...value.publisher, repoDir: absolute(value.publisher.repoDir, 'repoDir'), candidateRoot: absolute(value.publisher.candidateRoot, 'candidateRoot') },
  };
}

export async function readConfig(file) {
  return parseConfig(JSON.parse(await readFile(file, 'utf8')));
}
