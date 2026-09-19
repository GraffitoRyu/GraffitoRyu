#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConfig } from './config.mjs';
import { stableJson } from './contract.mjs';
import { capturePublisherHooks, verifyRuntimeManifest } from './publish.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

async function workingSourcePackage() {
  const manifest = {};
  const files = {};
  for (const name of (await readdir(sourceDir)).filter((name) => name.endsWith('.mjs')).sort()) {
    const content = await readFile(path.join(sourceDir, name));
    files[name] = content;
    manifest[name] = createHash('sha256').update(content).digest('hex');
  }
  return { files, manifest };
}

async function committedSourcePackage(requestedCommit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requestedCommit)) throw new Error('full source commit required');
  const repo = (await run('git', ['-C', sourceDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).stdout.trim();
  const sourceCommit = (await run('git', ['-C', repo, 'rev-parse', '--verify', `${requestedCommit}^{commit}`], { encoding: 'utf8' })).stdout.trim();
  if (sourceCommit !== requestedCommit) throw new Error('source commit mismatch');
  const prefix = path.relative(repo, sourceDir).split(path.sep).join('/');
  const listing = (await run('git', ['-C', repo, 'ls-tree', '-rz', sourceCommit, '--', prefix], { encoding: 'utf8' })).stdout;
  const entries = listing.split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/.exec(line);
    if (!match) throw new Error('invalid source tree entry');
    return { mode: match[1], file: match[2] };
  }).filter(({ file }) => path.posix.dirname(file) === prefix && file.endsWith('.mjs')).sort((a, b) => a.file.localeCompare(b.file));
  if (entries.length === 0) throw new Error('source commit has no runtime files');
  const files = {};
  const manifest = {};
  for (const entry of entries) {
    const name = path.posix.basename(entry.file);
    const content = (await run('git', ['-C', repo, 'show', `${sourceCommit}:${entry.file}`], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
    files[name] = content;
    manifest[name] = createHash('sha256').update(content).digest('hex');
  }
  return { files, manifest, sourceCommit };
}

function digestManifest(manifest) {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function collectorPlist({ label, nodeBinary, cli, configFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodeBinary)}</string><string>${xml(cli)}</string><string>collect</string><string>--config</string><string>${xml(configFile)}</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>900</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--plan') {
    const { manifest } = await workingSourcePackage();
    const digest = digestManifest(manifest);
    const role = args[1] === '--role' ? args[2] : null;
    if (!['collector', 'publisher'].includes(role)) throw new Error('role required');
    process.stdout.write(stableJson({
      status: 'plan-only',
      role,
      runtime: 'content-addressed-copy',
      runtimeDigest: digest,
      registration: 'requires explicit apply approval',
      label: role === 'collector' ? 'com.graffitoryu.profile-activity.collector' : 'com.graffitoryu.profile-activity.publisher',
      schedule: role === 'collector' ? 'login and 15-minute interval candidate' : 'single daily KST run candidate',
      publisherIsolation: role === 'publisher' ? 'private global lock and candidate worktree outside source checkout' : null,
      requiredPrivateValues: ['sourceId', 'logRoots', 'stateDir', 'runtimeDir', 'transportDir'],
    }));
    return;
  }
  if (!['--apply', '--remove'].includes(args[0]) || args[1] !== '--config' || !args[2]) throw new Error('usage');
  const config = await readConfig(args[2]);
  const installedConfigFile = path.join(config.stateDir, 'installed-config.json');
  const receiptFile = path.join(config.stateDir, 'installation-receipt.json');
  if (args[0] === '--remove') {
    if (path.resolve(args[2]) !== installedConfigFile) throw new Error('installed config required');
    const installedConfig = await readFile(installedConfigFile, 'utf8');
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    const runtimeManifestDigest = digestManifest(config.runtimeManifest);
    if (receipt.schemaVersion !== 1 || receipt.role !== config.role || receipt.stateDir !== config.stateDir || receipt.runtimeDir !== config.runtimeDir || receipt.runtimeDigest !== path.basename(config.runtimeDir) || receipt.runtimeDigest !== runtimeManifestDigest || receipt.runtimeManifestDigest !== runtimeManifestDigest || receipt.installedConfigDigest !== createHash('sha256').update(installedConfig).digest('hex') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.sourceCommit)) throw new Error('installation receipt mismatch');
    await verifyRuntimeManifest(config.runtimeDir, config.runtimeManifest);
    if (config.role === 'collector' && config.launchAgent) {
      await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${config.launchAgent.label}`]).catch(() => {});
      if (await exists(config.launchAgent.plistFile)) {
        const digest = createHash('sha256').update(await readFile(config.launchAgent.plistFile)).digest('hex');
        if (digest !== receipt.launchAgentDigest) throw new Error('launch agent receipt mismatch');
        await unlink(config.launchAgent.plistFile);
      }
    }
    const ownedRuntimeFiles = new Set([...Object.keys(config.runtimeManifest), 'manifest.json']);
    const runtimeEntries = await readdir(config.runtimeDir);
    if (runtimeEntries.length !== ownedRuntimeFiles.size || runtimeEntries.some((name) => !ownedRuntimeFiles.has(name))) throw new Error('runtime contains unmanaged files');
    const installedManifest = JSON.parse(await readFile(path.join(config.runtimeDir, 'manifest.json'), 'utf8'));
    if (stableJson(installedManifest) !== stableJson(config.runtimeManifest)) throw new Error('installed manifest mismatch');
    for (const name of Object.keys(config.runtimeManifest)) await unlink(path.join(config.runtimeDir, name));
    await unlink(path.join(config.runtimeDir, 'manifest.json'));
    await rmdir(config.runtimeDir);
    await unlink(installedConfigFile);
    await unlink(receiptFile);
    process.stdout.write(stableJson({ status: 'runtime-removed', registration: 'removed' }));
    return;
  }
  const commitIndex = args.indexOf('--source-commit');
  if (commitIndex < 0 || !args[commitIndex + 1]) throw new Error('source commit required');
  const sourcePackage = await committedSourcePackage(args[commitIndex + 1]);
  const { files, manifest, sourceCommit } = sourcePackage;
  const digest = digestManifest(manifest);
  if (config.role === 'collector' && !config.launchAgent) throw new Error('collector launchAgent required');
  const target = path.join(config.runtimeDir, digest);
  if (await exists(target) || await exists(installedConfigFile) || await exists(receiptFile) || (config.launchAgent && await exists(config.launchAgent.plistFile))) throw new Error('existing installation refused');
  if (config.launchAgent && await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${config.launchAgent.label}`]).then(() => true, () => false)) throw new Error('existing launch agent refused');
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const name of Object.keys(manifest)) await writeFile(path.join(target, name), files[name], { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(target, 'manifest.json'), stableJson(manifest), { flag: 'wx', mode: 0o600 });
  const gitBinary = (await run('/usr/bin/which', ['git'], { encoding: 'utf8' })).stdout.trim();
  let publisher = config.publisher;
  if (publisher) {
    const hooksPath = (await run('git', ['-C', publisher.repoDir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))).stdout.trim();
    if ((publisher.hooksPath ?? '') !== hooksPath) throw new Error('Git hooks changed');
    publisher = { ...publisher, hooksManifest: await capturePublisherHooks(publisher.repoDir) };
  }
  const installedConfig = stableJson({ ...config, publisher, runtimeDir: target, runtimeManifest: manifest });
  await writeFile(installedConfigFile, installedConfig, { flag: 'wx', mode: 0o600 });
  let registration = 'not-created';
  let launchAgentDigest = null;
  const receipt = () => ({ schemaVersion: 1, role: config.role, sourceCommit, stateDir: config.stateDir, runtimeDir: target, runtimeDigest: digest, runtimeManifestDigest: digestManifest(manifest), installedConfigDigest: createHash('sha256').update(installedConfig).digest('hex'), nodeBinary: process.execPath, gitBinary, launchAgentLabel: config.launchAgent?.label ?? null, launchAgentDigest, registration });
  if (config.launchAgent) {
    await mkdir(path.dirname(config.launchAgent.plistFile), { recursive: true, mode: 0o700 });
    const plist = collectorPlist({ label: config.launchAgent.label, nodeBinary: process.execPath, cli: path.join(target, 'cli.mjs'), configFile: installedConfigFile });
    launchAgentDigest = createHash('sha256').update(plist).digest('hex');
    await writeFile(config.launchAgent.plistFile, plist, { flag: 'wx', mode: 0o600 });
    registration = 'pending';
    await writeFile(receiptFile, stableJson(receipt()), { flag: 'wx', mode: 0o600 });
    await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, config.launchAgent.plistFile]);
    registration = 'active';
    await writeFile(receiptFile, stableJson(receipt()), { mode: 0o600 });
  } else {
    await writeFile(receiptFile, stableJson(receipt()), { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(stableJson({ status: 'runtime-installed', runtimeDigest: digest, registration }));
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('{"status":"error"}\n');
    process.exitCode = 1;
  });
}
