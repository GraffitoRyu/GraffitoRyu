#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let addDays;
let parseAccountUsage;
let atomicWrite;
let collectLogRoots;
let parseDate;
let parsePrivateSnapshot;
let probeLogRoots;
let publishCollection;
let readConfig;
let readSnapshot;
let stableJson;
let classifyFailure;
let executionStage = 'startup';
let stateChanged = false;

function startupFailure(error) {
  const permission = ['EACCES', 'EPERM'].includes(error?.code);
  const validation = !permission && /invalid|usage|required|refused/i.test(error?.message ?? '');
  return { status: 'error', stage: executionStage, exitCode: 1, signal: null, errorClass: permission ? 'permission' : validation ? 'validation' : 'integrity', stderrClass: permission ? 'permission-denied' : validation ? 'validation-rejected' : 'integrity-rejected', stateChanged };
}

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
    if (!(argv[0] === 'probe' || argv.includes('--dry-run'))) throw new Error('installed runtime manifest required');
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
  if (receipt.schemaVersion !== 1 || receipt.stateDir !== stateDir || receipt.runtimeDir !== config.runtimeDir || receipt.runtimeDigest !== path.basename(runtimeDir) || receipt.runtimeDigest !== manifestDigest || receipt.runtimeManifestDigest !== manifestDigest || receipt.installedConfigDigest !== sha256(configText) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.sourceCommit)) throw new Error('installation receipt mismatch');
}

async function loadRuntime() {
  ({ parseAccountUsage } = await import('./account-usage.mjs'));
  ({ collectLogRoots, probeLogRoots } = await import('./collect.mjs'));
  ({ readConfig } = await import('./config.mjs'));
  ({ addDays, parseDate, parsePrivateSnapshot, stableJson } = await import('./contract.mjs'));
  ({ publishCollection } = await import('./publish.mjs'));
  ({ failureEvidence: classifyFailure } = await import('./delivery-execution.mjs'));
  ({ atomicWrite, readSnapshot } = await import('./snapshot.mjs'));
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const configIndex = rest.indexOf('--config');
  if (!['probe', 'collect', 'run'].includes(command) || configIndex < 0 || !rest[configIndex + 1]) throw new Error('usage');
  const dateIndex = rest.indexOf('--as-of');
  return { command, configFile: rest[configIndex + 1], dryRun: rest.includes('--dry-run'), asOfDate: dateIndex < 0 ? null : parseDate(rest[dateIndex + 1]) };
}

async function readPrivateInput() {
  let input = '';
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) throw new Error('private input too large');
    input += chunk;
  }
  return JSON.parse(input);
}

function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return parts.filter(({ type }) => type !== 'literal').map(({ value }) => value).join('-');
}

async function collect(config, asOfDate, dryRun) {
  const cacheFile = path.join(config.stateDir, 'collector-cache.json');
  let cache = { files: {} };
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
  const from = addDays(asOfDate, -(config.publicDays - 1));
  const result = await collectLogRoots({ logRoots: config.logRoots, excludedRepoRoots: config.excludedRepoRoots, from, to: asOfDate, cache });
  const snapshotFile = path.join(config.stateDir, 'snapshot.json');
  let revision = 1;
  try {
    revision = (await readSnapshot(snapshotFile, config.stateDir)).revision + 1;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (!/invalid private snapshot keys/.test(error.message)) throw error;
      const { sourceId, ...anonymous } = JSON.parse(await readFile(snapshotFile, 'utf8'));
      if (sourceId !== config.sourceId) throw new Error('draft source mismatch');
      const migrated = parsePrivateSnapshot(anonymous);
      if (migrated.schemaVersion !== 3) throw new Error('invalid draft snapshot');
      revision = migrated.revision + 1;
    }
  }
  const snapshot = {
    schemaVersion: 3,
    revision,
    policyId: config.policyId,
    collectedAt: new Date().toISOString(),
    timezone: config.timezone,
    window: { from, to: asOfDate },
    days: result.days,
  };
  if (!dryRun) {
    await atomicWrite(cacheFile, result.cache, config.stateDir);
    await atomicWrite(snapshotFile, parsePrivateSnapshot(snapshot), config.stateDir);
  }
  const known = (key) => result.days.every((day) => day[key] !== null);
  return { snapshot, summary: {
    files: result.files,
    coverage: result.days.some((day) => day.coverage === 'unknown') ? 'unknown' : result.partial ? 'partial' : 'complete',
    activeDays: known('active') ? result.days.filter((day) => day.active).length : null,
    sessionDays: known('activeSessions') ? result.days.reduce((sum, day) => sum + day.activeSessions, 0) : null,
    toolCalls: known('toolCalls') ? result.days.reduce((sum, day) => sum + day.toolCalls, 0) : null,
    totalTokens: known('tokens') ? result.days.reduce((sum, day) => sum + day.tokens, 0) : null,
  } };
}

async function main() {
  const requestedCommand = process.argv[2];
  if (['probe', 'collect', 'run'].includes(requestedCommand)) executionStage = requestedCommand;
  await verifyBeforeImport(process.argv.slice(2));
  await loadRuntime();
  const args = argumentsFor(process.argv.slice(2));
  const config = await readConfig(args.configFile);
  const asOfDate = args.asOfDate ?? todayKst();
  if (args.command === 'probe') {
    process.stdout.write(stableJson({ status: 'ok', ...(await probeLogRoots(config.logRoots)) }));
    return;
  }
  if (args.command === 'collect') {
    if (!args.dryRun) stateChanged = 'unknown';
    const result = await collect(config, asOfDate, args.dryRun);
    stateChanged = !args.dryRun;
    process.stdout.write(stableJson({ status: args.dryRun ? 'dry-run' : 'collected', ...result.summary }));
    return;
  }
  if (!config.publisher) throw new Error('repository publication config required');
  let accountUsage = null;
  if (process.argv.includes('--account-usage-stdin')) {
    if (config.collectionSlot !== 'macmini' || config.role !== 'publisher') throw new Error('publisher account usage required');
    accountUsage = parseAccountUsage(await readPrivateInput());
    if (!args.dryRun) {
      stateChanged = 'unknown';
      await atomicWrite(path.join(config.stateDir, 'account-usage.json'), accountUsage, config.stateDir);
      stateChanged = true;
    }
  }
  if (!args.dryRun) stateChanged = 'unknown';
  const { snapshot } = await collect(config, asOfDate, args.dryRun);
  const result = await publishCollection(config, snapshot, { dryRun: args.dryRun, accountUsage });
  if (!args.dryRun) stateChanged = true;
  process.stdout.write(stableJson(result));
}

main().catch((error) => {
  const evidence = classifyFailure
    ? classifyFailure({ stage: executionStage, error, stateChanged, exitCode: 1 })
    : startupFailure(error);
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = 1;
});
