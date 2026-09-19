import path from 'node:path';
import { readSnapshot } from './snapshot.mjs';
import { collectionPath } from './collection.mjs';
import { parseRepositoryCollection } from './contract.mjs';

export async function repositoryCollectionDecision({ repo, collection, now, staleAfterHours = 36 }) {
  const clock = kstParts(now);
  let peer;
  try {
    peer = parseRepositoryCollection(await readSnapshot(path.join(repo, collectionPath('macbook')), repo));
  } catch (error) {
    if (error.code && error.code !== 'ENOENT' || /symlink|escaped/.test(error.message)) throw error;
    return { status: 'awaiting-source', date: clock.date };
  }
  const snapshots = [{ sourceId: 'macbook', snapshot: peer }, { sourceId: 'macmini', snapshot: collection }];
  if (snapshots.some(({ snapshot }) => snapshot.window.to !== clock.date || new Date(snapshot.collectedAt) > clock.instant || clock.instant - new Date(snapshot.collectedAt) > staleAfterHours * 3600000)) return { status: 'awaiting-source', date: clock.date };
  return { status: 'ready', date: clock.date, snapshots };
}

function kstParts(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) throw new Error('invalid publication time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, part]));
  return { instant, date: `${parts.year}-${parts.month}-${parts.day}` };
}
