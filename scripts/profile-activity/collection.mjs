import { addDays, parsePrivateSnapshot, stableJson } from './contract.mjs';

export const COLLECTION_PATHS = ['metrics/codex-activity-macbook.json', 'metrics/codex-activity-macmini.json'];
const KEYS = ['schemaVersion', 'metricScope', 'timezone', 'window', 'days'];

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`invalid ${name} keys`);
}

export function parseActivityCollection(value) {
  exactKeys(value, KEYS, 'activity collection');
  if (value.schemaVersion !== 1 || value.metricScope !== 'observed-local-codex-collection' || value.timezone !== 'Asia/Seoul') throw new Error('invalid activity collection identity');
  const snapshot = parsePrivateSnapshot({
    schemaVersion: 3,
    revision: 1,
    policyId: 'local-codex-v1-kst-exclude-profile',
    collectedAt: '2000-01-01T00:00:00.000Z',
    timezone: value.timezone,
    window: value.window,
    days: value.days,
  });
  return { schemaVersion: 1, metricScope: 'observed-local-codex-collection', timezone: snapshot.timezone, window: snapshot.window, days: snapshot.days };
}

export function activityCollectionFromSnapshot(value) {
  const snapshot = parsePrivateSnapshot(value);
  if (snapshot.schemaVersion !== 3) throw new Error('private v3 snapshot required');
  return parseActivityCollection({ schemaVersion: 1, metricScope: 'observed-local-codex-collection', timezone: snapshot.timezone, window: snapshot.window, days: snapshot.days });
}

export function currentActivityCollections(values, asOfDate) {
  if (!Array.isArray(values) || values.length !== 2) return null;
  try {
    const collections = values.map(parseActivityCollection);
    const from = addDays(asOfDate, -29);
    if (collections.some((value) => value.window.from !== from || value.window.to !== asOfDate)) return null;
    return collections;
  } catch {
    return null;
  }
}

export function canonicalCollection(value) {
  return stableJson(parseActivityCollection(value));
}
