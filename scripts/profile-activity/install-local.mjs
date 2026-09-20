#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConfig } from './config.mjs';
import { stableJson } from './contract.mjs';
import { capturePublisherHooks, verifyRuntimeManifest } from './publish.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

async function sourcePackage(requestedCommit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requestedCommit)) throw new Error('full source commit required');
  const repo = (await run('git', ['-C', sourceDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).stdout.trim();
  const sourceCommit = (await run('git', ['-C', repo, 'rev-parse', '--verify', `${requestedCommit}^{commit}`], { encoding: 'utf8' })).stdout.trim();
  if (sourceCommit !== requestedCommit) throw new Error('source commit mismatch');
  const prefix = path.relative(repo, sourceDir).split(path.sep).join('/');
  const listing = (await run('git', ['-C', repo, 'ls-tree', '-rz', sourceCommit, '--', prefix], { encoding: 'utf8' })).stdout;
  const entries = listing.split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/.exec(line);
    if (!match) throw new Error('invalid source tree entry');
    return match[2];
  }).filter((file) => path.posix.dirname(file) === prefix && file.endsWith('.mjs')).sort();
  if (entries.length === 0) throw new Error('source commit has no runtime files');
  const files = {};
  const manifest = {};
  for (const file of entries) {
    const name = path.posix.basename(file);
    const content = (await run('git', ['-C', repo, 'show', `${sourceCommit}:${file}`], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
    files[name] = content;
    manifest[name] = createHash('sha256').update(content).digest('hex');
  }
  return { files, manifest, sourceCommit };
}

function digestManifest(manifest) {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function validateInstallation(config, configFile) {
  const installedConfigFile = path.join(config.stateDir, 'installed-config.json');
  const receiptFile = path.join(config.stateDir, 'installation-receipt.json');
  if (path.resolve(configFile) !== installedConfigFile) throw new Error('installed config required');
  const installedConfig = await readFile(installedConfigFile, 'utf8');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  const runtimeDigest = digestManifest(config.runtimeManifest);
  if (receipt.schemaVersion !== 2 || receipt.stateDir !== config.stateDir || receipt.runtimeDir !== config.runtimeDir || receipt.runtimeDigest !== runtimeDigest || receipt.installedConfigDigest !== createHash('sha256').update(installedConfig).digest('hex') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.sourceCommit)) throw new Error('installation receipt mismatch');
  await verifyRuntimeManifest(config.runtimeDir, config.runtimeManifest);
  return { installedConfig, installedConfigFile, receipt, receiptFile };
}

async function removeRuntime(config) {
  const owned = new Set([...Object.keys(config.runtimeManifest), 'manifest.json']);
  const entries = await readdir(config.runtimeDir);
  if (entries.length !== owned.size || entries.some((name) => !owned.has(name))) throw new Error('runtime contains unmanaged files');
  for (const name of entries) await unlink(path.join(config.runtimeDir, name));
  await rmdir(config.runtimeDir);
}

async function writeRuntime(target, files, manifest) {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const name of Object.keys(manifest)) await writeFile(path.join(target, name), files[name], { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(target, 'manifest.json'), stableJson(manifest), { flag: 'wx', mode: 0o600 });
  await verifyRuntimeManifest(target, manifest);
}

function receipt({ sourceCommit, stateDir, runtimeDir, runtimeDigest, installedConfig, gitBinary }) {
  return stableJson({ schemaVersion: 2, sourceCommit, stateDir, runtimeDir, runtimeDigest, installedConfigDigest: createHash('sha256').update(installedConfig).digest('hex'), nodeBinary: process.execPath, gitBinary });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--plan') {
    process.stdout.write(stableJson({ status: 'plan-only', runtime: 'content-addressed-copy', scheduler: 'external', schedule: 'daily at 00:30 UTC', requiredPrivateValues: ['codexBinary', 'stateDir', 'runtimeDir', 'publisher'] }));
    return;
  }
  if (!['--apply', '--remove', '--replace'].includes(args[0]) || args[1] !== '--config' || !args[2]) throw new Error('usage');
  const config = await readConfig(args[2]);
  const installedConfigFile = path.join(config.stateDir, 'installed-config.json');
  const receiptFile = path.join(config.stateDir, 'installation-receipt.json');
  if (args[0] === '--remove') {
    await validateInstallation(config, args[2]);
    await removeRuntime(config);
    await unlink(installedConfigFile);
    await unlink(receiptFile);
    process.stdout.write(stableJson({ status: 'runtime-removed' }));
    return;
  }
  const commitIndex = args.indexOf('--source-commit');
  if (commitIndex < 0 || !args[commitIndex + 1]) throw new Error('source commit required');
  const { files, manifest, sourceCommit } = await sourcePackage(args[commitIndex + 1]);
  const runtimeDigest = digestManifest(manifest);
  const gitBinary = (await run('/usr/bin/which', ['git'], { encoding: 'utf8' })).stdout.trim();
  const hooksPath = (await run('git', ['-C', config.publisher.repoDir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))).stdout.trim();
  if ((config.publisher.hooksPath ?? '') !== hooksPath) throw new Error('Git hooks changed');
  const publisher = { ...config.publisher, hooksManifest: await capturePublisherHooks(config.publisher.repoDir) };
  if (args[0] === '--replace') {
    const current = await validateInstallation(config, args[2]);
    const target = path.join(path.dirname(config.runtimeDir), runtimeDigest);
    if (target === config.runtimeDir || await exists(target)) throw new Error('replacement target exists');
    await writeRuntime(target, files, manifest);
    const installedConfig = stableJson({ ...config, publisher, runtimeDir: target, runtimeManifest: manifest });
    const configTemp = `${installedConfigFile}.${process.pid}.tmp`;
    const receiptTemp = `${receiptFile}.${process.pid}.tmp`;
    try {
      await writeFile(configTemp, installedConfig, { flag: 'wx', mode: 0o600 });
      await writeFile(receiptTemp, receipt({ sourceCommit, stateDir: config.stateDir, runtimeDir: target, runtimeDigest, installedConfig, gitBinary }), { flag: 'wx', mode: 0o600 });
      await rename(configTemp, installedConfigFile);
      await rename(receiptTemp, receiptFile);
    } catch (error) {
      await writeFile(installedConfigFile, current.installedConfig, { mode: 0o600 });
      await writeFile(receiptFile, stableJson(current.receipt), { mode: 0o600 });
      throw error;
    }
    let cleanup = 'complete';
    try { await removeRuntime(config); } catch { cleanup = 'pending'; }
    process.stdout.write(stableJson({ status: 'runtime-replaced', cleanup }));
    return;
  }
  const target = path.join(config.runtimeDir, runtimeDigest);
  if (await exists(target) || await exists(installedConfigFile) || await exists(receiptFile)) throw new Error('existing installation refused');
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeRuntime(target, files, manifest);
  const installedConfig = stableJson({ ...config, publisher, runtimeDir: target, runtimeManifest: manifest });
  await writeFile(installedConfigFile, installedConfig, { flag: 'wx', mode: 0o600 });
  await writeFile(receiptFile, receipt({ sourceCommit, stateDir: config.stateDir, runtimeDir: target, runtimeDigest, installedConfig, gitBinary }), { flag: 'wx', mode: 0o600 });
  process.stdout.write(stableJson({ status: 'runtime-installed', runtimeDigest }));
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('{"status":"error"}\n');
    process.exitCode = 1;
  });
}
