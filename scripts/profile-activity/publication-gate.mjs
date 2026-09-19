import { readFile } from 'node:fs/promises';
import { parseDate, parsePrivateSnapshot } from './contract.mjs';
import { withPublisherLock } from './publish.mjs';
import { atomicWrite, chooseLatestSnapshots } from './snapshot.mjs';

function kstParts(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) throw new Error('invalid publication time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, part]));
  return { instant, date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function parseReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid publication receipt');
  if (Object.keys(value).sort().join(',') !== 'commit,date,schemaVersion,status') throw new Error('invalid publication receipt keys');
  if (value.schemaVersion !== 1 || !['published', 'no-op'].includes(value.status)) throw new Error('invalid publication receipt');
  const date = parseDate(value.date, 'receipt date');
  if (value.commit !== null && (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit))) throw new Error('invalid publication commit');
  return { schemaVersion: 1, date, status: value.status, commit: value.commit };
}

export function publicationDecision({ snapshots, expectedSourceIds, now, receipt, staleAfterHours = 36 }) {
  const clock = kstParts(now);
  if (clock.hour < 8) return { status: 'before-window', date: clock.date };
  if (receipt && parseReceipt(receipt).date === clock.date) return { status: 'already-published', date: clock.date };
  const selected = chooseLatestSnapshots(snapshots, expectedSourceIds);
  const versions = new Set(selected.map(({ schemaVersion }) => schemaVersion));
  if (selected.length !== expectedSourceIds.length || versions.size !== 1 || ![2, 3].includes(selected[0]?.schemaVersion) || selected.some((snapshot) => snapshot.window.to !== clock.date)) return { status: 'awaiting-source', date: clock.date };
  if (selected.some((snapshot) => new Date(snapshot.collectedAt) > clock.instant)) throw new Error('future snapshot');
  if (selected.some((snapshot) => clock.instant - new Date(snapshot.collectedAt) > staleAfterHours * 3600000)) return { status: 'awaiting-source', date: clock.date };
  return { status: 'ready', date: clock.date, snapshots: selected.map(parsePrivateSnapshot) };
}

export function publicationReceipt({ date, result }) {
  parseDate(date, 'receipt date');
  if (!result || !['published', 'no-op'].includes(result.status)) throw new Error('invalid publication result');
  const commit = result.commit ?? null;
  if (commit !== null && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) throw new Error('invalid publication commit');
  return { schemaVersion: 1, date, status: result.status, commit };
}

export async function publishIfReady({ config, snapshots, expectedSourceIds, now, receiptFile, publish }) {
  return withPublisherLock(config.stateDir, async () => {
    let receipt = null;
    try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const decision = publicationDecision({ snapshots, expectedSourceIds, now, receipt, staleAfterHours: config.staleAfterHours });
    if (decision.status !== 'ready') return decision;
    const result = await publish(decision.snapshots);
    await atomicWrite(receiptFile, publicationReceipt({ date: decision.date, result }), config.stateDir);
    return result;
  });
}
