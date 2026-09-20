#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let addDays;
let failureEvidence;
let parseDate;
let publishGenerated;
let readAccountTokenUsage;
let readConfig;
let renderActivitySvg;
let stableJson;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function verifyBeforeImport(argv) {
  const configIndex = argv.indexOf('--config');
  if (configIndex < 0 || !argv[configIndex + 1]) throw new Error('usage');
  const configFile = path.resolve(argv[configIndex + 1]);
  const configText = await readFile(configFile, 'utf8');
  const config = JSON.parse(configText);
  const manifest = config.runtimeManifest;
  const names = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? Object.keys(manifest).sort() : [];
  if (names.length === 0) {
    if (!argv.includes('--dry-run')) throw new Error('installed runtime manifest required');
    return;
  }
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimeNames = (await readdir(runtimeDir)).filter((name) => name.endsWith('.mjs')).sort();
  if (names.length !== runtimeNames.length || names.some((name, index) => name !== runtimeNames[index])) throw new Error('incomplete runtime manifest');
  for (const name of names) {
    if (path.basename(name) !== name || !/^[0-9a-f]{64}$/.test(manifest[name])) throw new Error('invalid runtime manifest');
    const file = path.join(runtimeDir, name);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || sha256(await readFile(file)) !== manifest[name]) throw new Error('runtime digest mismatch');
  }
  const stateDir = path.resolve(config.stateDir);
  if (configFile !== path.join(stateDir, 'installed-config.json') || await realpath(config.runtimeDir) !== runtimeDir) throw new Error('installed runtime path mismatch');
  const receipt = JSON.parse(await readFile(path.join(stateDir, 'installation-receipt.json'), 'utf8'));
  const manifestDigest = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
  if (receipt.schemaVersion !== 2 || receipt.stateDir !== stateDir || receipt.runtimeDir !== config.runtimeDir || receipt.runtimeDigest !== manifestDigest || receipt.installedConfigDigest !== sha256(configText) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.sourceCommit)) throw new Error('installation receipt mismatch');
}

async function loadRuntime() {
  ({ addDays, parseDate, stableJson } = await import('./contract.mjs'));
  ({ failureEvidence } = await import('./execution.mjs'));
  ({ readAccountTokenUsage } = await import('./app-server-usage.mjs'));
  ({ readConfig } = await import('./config.mjs'));
  ({ publishGenerated } = await import('./publish.mjs'));
  ({ renderActivitySvg } = await import('./render.mjs'));
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const configIndex = rest.indexOf('--config');
  if (command !== 'run' || configIndex < 0 || !rest[configIndex + 1]) throw new Error('usage');
  const dateIndex = rest.indexOf('--as-of');
  return { configFile: rest[configIndex + 1], dryRun: rest.includes('--dry-run'), asOfDate: dateIndex < 0 ? null : parseDate(rest[dateIndex + 1]) };
}

function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return parts.filter(({ type }) => type !== 'literal').map(({ value }) => value).join('-');
}

async function main() {
  await verifyBeforeImport(process.argv.slice(2));
  await loadRuntime();
  const args = argumentsFor(process.argv.slice(2));
  const config = await readConfig(args.configFile);
  const asOfDate = args.asOfDate ?? todayKst();
  const activity = await readAccountTokenUsage({ codexBinary: config.codexBinary, window: { from: addDays(asOfDate, -29), to: asOfDate } });
  const generated = {
    'metrics/codex-activity.json': stableJson(activity),
    'assets/codex-activity.svg': renderActivitySvg(activity),
    'assets/codex-activity-ko.svg': renderActivitySvg(activity, 'ko'),
  };
  process.stdout.write(stableJson(await publishGenerated(config, generated, { dryRun: args.dryRun })));
}

main().catch((error) => {
  const evidence = failureEvidence
    ? failureEvidence({ stage: 'run', error, stateChanged: 'unknown', exitCode: 1 })
    : { status: 'error', stage: 'startup', exitCode: 1, signal: null, errorClass: 'integrity', stderrClass: 'integrity-rejected', stateChanged: false };
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = 1;
});
