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
let readConfig;
let readSnapshot;
let renderActivitySvg;
let saveAndExportSnapshot;
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
  ({ publishGenerated } = await import('./publish.mjs'));
  ({ renderActivitySvg } = await import('./render.mjs'));
  ({ atomicWrite, readSnapshot, saveAndExportSnapshot } = await import('./snapshot.mjs'));
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const configIndex = rest.indexOf('--config');
  if (!['probe', 'collect', 'refresh', 'run'].includes(command) || configIndex < 0 || !rest[configIndex + 1]) throw new Error('usage');
  const dateIndex = rest.indexOf('--as-of');
  return { command, configFile: rest[configIndex + 1], dryRun: rest.includes('--dry-run'), asOfDate: dateIndex < 0 ? null : parseDate(rest[dateIndex + 1]) };
}

function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return parts.filter(({ type }) => type !== 'literal').map(({ value }) => value).join('-');
}

async function collect(config, asOfDate, dryRun) {
  const cacheFile = path.join(config.stateDir, 'collector-cache.json');
  let cache = { files: {} };
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
  const from = addDays(asOfDate, -(config.retentionDays - 1));
  const result = await collectLogRoots({ logRoots: config.logRoots, excludedRepoRoots: config.excludedRepoRoots, from, to: asOfDate, cache });
  const snapshotFile = path.join(config.stateDir, 'snapshot.json');
  let revision = 1;
  try { revision = (await readSnapshot(snapshotFile, config.stateDir)).revision + 1; } catch {}
  const snapshot = {
    schemaVersion: 2,
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

async function aggregate(config, selfSnapshot, asOfDate, persistLastGood) {
  const snapshots = [];
  for (const source of config.expectedSources) {
    if (source.sourceId === config.sourceId && selfSnapshot) snapshots.push(selfSnapshot);
    else {
      const scope = source.location === 'local' ? config.stateDir : config.transportDir;
      const cacheFile = path.join(config.stateDir, `last-good-${source.sourceId}.json`);
      let lastGood = null;
      try { lastGood = await readSnapshot(cacheFile, config.stateDir); } catch {}
      try {
        const incoming = await readSnapshot(source.file, scope);
        if (lastGood && (incoming.revision < lastGood.revision || (incoming.revision === lastGood.revision && stableJson(incoming) !== stableJson(lastGood)))) snapshots.push(lastGood);
        else {
          snapshots.push(incoming);
          if (persistLastGood) await atomicWrite(cacheFile, incoming, config.stateDir);
        }
      } catch {
        if (lastGood) snapshots.push(lastGood);
      }
    }
  }
  return aggregateSnapshots(snapshots, { asOfDate, referenceTime: new Date().toISOString(), expectedSourceIds: config.expectedSources.map(({ sourceId }) => sourceId), independentSources: config.independentSources, staleAfterHours: config.staleAfterHours });
}

async function main() {
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
    const result = await collect(config, asOfDate, args.dryRun);
    process.stdout.write(stableJson({ status: args.dryRun ? 'dry-run' : 'collected', ...result.summary }));
    return;
  }
  if (config.role !== 'publisher') throw new Error('publisher role required');
  const collected = args.command === 'run' ? await collect(config, asOfDate, args.dryRun) : { snapshot: null };
  const activity = await aggregate(config, collected.snapshot, asOfDate, !args.dryRun);
  const generated = { 'metrics/codex-activity.json': stableJson(activity), 'assets/codex-activity.svg': renderActivitySvg(activity) };
  if (args.dryRun) {
    await publishGenerated(config, generated, { dryRun: true });
    await atomicWrite(path.join(config.stateDir, 'preview.json'), generated['metrics/codex-activity.json'], config.stateDir);
    await atomicWrite(path.join(config.stateDir, 'preview.svg'), generated['assets/codex-activity.svg'], config.stateDir);
    process.stdout.write(stableJson({ status: 'dry-run', aggregateStatus: activity.status }));
    return;
  }
  if (!isPublishableActivity(activity)) throw new Error('aggregate unavailable');
  process.stdout.write(stableJson(await publishGenerated(config, generated)));
}

main().catch(() => {
  process.stderr.write('{"status":"error"}\n');
  process.exitCode = 1;
});
