#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let addDays;
let aggregateSnapshots;
let atomicWrite;
let collectLogRoots;
let isPublishableActivity;
let parseDate;
let probeLogRoots;
let publishGenerated;
let publishGeneratedUnlocked;
let publishIfReady;
let readConfig;
let readSnapshot;
let renderActivitySvg;
let nextDelivery;
let acceptAcknowledgement;
let receiveEnvelope;
let saveAndExportSnapshot;
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
  ({ aggregateSnapshots } = await import('./aggregate.mjs'));
  ({ collectLogRoots, probeLogRoots } = await import('./collect.mjs'));
  ({ readConfig } = await import('./config.mjs'));
  ({ addDays, isPublishableActivity, parseDate, stableJson } = await import('./contract.mjs'));
  ({ publishGenerated, publishGeneratedUnlocked } = await import('./publish.mjs'));
  ({ publishIfReady } = await import('./publication-gate.mjs'));
  ({ acceptAcknowledgement, nextDelivery, receiveEnvelope } = await import('./relay.mjs'));
  ({ failureEvidence: classifyFailure } = await import('./delivery-execution.mjs'));
  ({ renderActivitySvg } = await import('./render.mjs'));
  ({ atomicWrite, readSnapshot, saveAndExportSnapshot } = await import('./snapshot.mjs'));
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const configIndex = rest.indexOf('--config');
  if (!['probe', 'collect', 'refresh', 'run', 'outbox', 'acknowledge', 'receive'].includes(command) || configIndex < 0 || !rest[configIndex + 1]) throw new Error('usage');
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
  try { revision = (await readSnapshot(snapshotFile, config.stateDir)).revision + 1; } catch {}
  const snapshot = {
    schemaVersion: 3,
    sourceId: config.sourceId,
    revision,
    policyId: config.policyId,
    collectedAt: new Date().toISOString(),
    timezone: config.timezone,
    window: { from, to: asOfDate },
    days: result.days,
  };
  if (!dryRun) {
    await atomicWrite(cacheFile, result.cache, config.stateDir);
    const exportFile = config.transportDir ? path.join(config.transportDir, `${config.sourceId}.json`) : null;
    await saveAndExportSnapshot({ snapshot, localFile: snapshotFile, localScope: config.stateDir, exportFile, exportScope: config.transportDir });
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

async function publisherSnapshots(config) {
  const snapshots = [];
  for (const source of config.expectedSources) {
    if (source.sourceId === config.sourceId) {
      try { snapshots.push(await readSnapshot(path.join(config.stateDir, 'snapshot.json'), config.stateDir)); } catch {}
      continue;
    }
    const cacheFile = path.join(config.stateDir, `last-good-${source.sourceId}.json`);
    try {
      snapshots.push(await readSnapshot(cacheFile, config.stateDir));
      continue;
    } catch {}
    const scope = source.location === 'local' ? config.stateDir : config.transportDir;
    try { snapshots.push(await readSnapshot(source.file, scope)); } catch {}
  }
  return snapshots;
}

async function main() {
  const requestedCommand = process.argv[2];
  if (['probe', 'collect', 'refresh', 'run', 'outbox', 'acknowledge', 'receive'].includes(requestedCommand)) executionStage = requestedCommand;
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
  if (args.command === 'outbox') {
    if (config.role !== 'collector') throw new Error('collector role required');
    const stateFile = path.join(config.stateDir, 'delivery-state.json');
    const snapshot = await readSnapshot(path.join(config.stateDir, 'snapshot.json'), config.stateDir);
    let state = null;
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = nextDelivery({ snapshot, state, date: todayKst() });
    await atomicWrite(stateFile, result.state, config.stateDir);
    stateChanged = true;
    process.stdout.write(stableJson({ status: result.status, ...(result.envelope && { envelope: result.envelope }) }));
    return;
  }
  if (args.command === 'acknowledge') {
    if (config.role !== 'collector') throw new Error('collector role required');
    const stateFile = path.join(config.stateDir, 'delivery-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const accepted = acceptAcknowledgement({ acknowledgement: await readPrivateInput(), state });
    await atomicWrite(stateFile, accepted, config.stateDir);
    stateChanged = true;
    process.stdout.write(stableJson({ status: 'acknowledged', revision: accepted.acknowledgedRevision, digest: accepted.acknowledgedDigest }));
    return;
  }
  if (config.role !== 'publisher') throw new Error('publisher role required');
  if (args.command === 'receive') {
    const sources = config.expectedSources.filter(({ location, sourceId }) => location === 'transport' && sourceId !== config.sourceId);
    if (sources.length !== 1) throw new Error('single transport source required');
    const source = sources[0];
    const result = await receiveEnvelope({ envelope: await readPrivateInput(), expectedSourceId: source.sourceId, lastGoodFile: path.join(config.stateDir, `last-good-${source.sourceId}.json`), stateScope: config.stateDir });
    stateChanged = result.status === 'received';
    process.stdout.write(stableJson(result));
    return;
  }
  const now = new Date().toISOString();
  const snapshots = await publisherSnapshots(config);
  if (args.dryRun) {
    const activity = aggregateSnapshots(snapshots, { asOfDate, referenceTime: now, expectedSourceIds: config.expectedSources.map(({ sourceId }) => sourceId), independentSources: config.independentSources, staleAfterHours: config.staleAfterHours });
    const generated = { 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) };
    await publishGenerated(config, generated, { dryRun: true });
    stateChanged = 'unknown';
    await atomicWrite(path.join(config.stateDir, 'preview.json'), generated['metrics/codex-activity.json'], config.stateDir);
    await atomicWrite(path.join(config.stateDir, 'preview.svg'), generated['assets/codex-activity.svg'], config.stateDir);
    stateChanged = true;
    process.stdout.write(stableJson({ status: 'dry-run', aggregateStatus: activity.status }));
    return;
  }
  if (stateChanged === false) stateChanged = 'unknown';
  const result = await publishIfReady({
    config,
    snapshots,
    expectedSourceIds: config.expectedSources.map(({ sourceId }) => sourceId),
    now,
    receiptFile: path.join(config.stateDir, 'publication-receipt.json'),
    publish: async (readySnapshots) => {
      const activity = aggregateSnapshots(readySnapshots, { asOfDate, referenceTime: now, expectedSourceIds: config.expectedSources.map(({ sourceId }) => sourceId), independentSources: config.independentSources, staleAfterHours: config.staleAfterHours });
      if (!isPublishableActivity(activity)) throw new Error('aggregate unavailable');
      return publishGeneratedUnlocked(config, { 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) });
    },
  });
  process.stdout.write(stableJson(result));
}

main().catch((error) => {
  const evidence = classifyFailure
    ? classifyFailure({ stage: executionStage, error, stateChanged, exitCode: 1 })
    : startupFailure(error);
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = 1;
});
