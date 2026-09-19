import { parseDate, parsePrivateSnapshot, stableJson } from './contract.mjs';
import { atomicWrite, readSnapshot, snapshotDigest } from './snapshot.mjs';

function schemaFor(version) {
  if (![2, 3].includes(version)) throw new Error('schema v2 or v3 required');
  return `PROFILE_ACTIVITY_SNAPSHOT_V${version}`;
}

export function createEnvelope(value) {
  const snapshot = parsePrivateSnapshot(value);
  return { schema: schemaFor(snapshot.schemaVersion), revision: snapshot.revision, ...(snapshot.schemaVersion === 3 ? {} : { digest: snapshotDigest(snapshot) }), snapshot };
}

export function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
  const snapshot = parsePrivateSnapshot(value.snapshot);
  const schema = schemaFor(snapshot.schemaVersion);
  const expectedKeys = snapshot.schemaVersion === 3 ? 'revision,schema,snapshot' : 'digest,revision,schema,snapshot';
  if (Object.keys(value).sort().join(',') !== expectedKeys) throw new Error('invalid envelope keys');
  if (value.schema !== schema || value.revision !== snapshot.revision) throw new Error('invalid envelope identity');
  if (snapshot.schemaVersion !== 3 && (!/^[0-9a-f]{64}$/.test(value.digest) || value.digest !== snapshotDigest(snapshot))) throw new Error('digest mismatch');
  return { schema, revision: snapshot.revision, ...(snapshot.schemaVersion === 3 ? {} : { digest: value.digest }), snapshot };
}

function deliveryState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid delivery state');
  if (Object.keys(value).sort().join(',') !== 'acknowledgedDigest,acknowledgedRevision,attempts,date,envelope') throw new Error('invalid delivery state keys');
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error('invalid delivery date');
  const envelope = parseEnvelope(value.envelope);
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 1 || value.attempts > 4) throw new Error('invalid delivery attempts');
  if (value.acknowledgedRevision !== null && (!Number.isSafeInteger(value.acknowledgedRevision) || value.acknowledgedRevision < 1)) throw new Error('invalid acknowledgement revision');
  if (value.acknowledgedDigest !== null && !/^[0-9a-f]{64}$/.test(value.acknowledgedDigest)) throw new Error('invalid acknowledgement digest');
  return { ...value, envelope };
}

export function nextDelivery({ snapshot, state, date }) {
  parseDate(date, 'delivery date');
  const fresh = createEnvelope(snapshot);
  let current;
  if (!state || state.date !== date) current = { date, envelope: fresh, attempts: 0, acknowledgedRevision: null, acknowledgedDigest: null };
  else current = deliveryState(state);
  const acknowledged = current.acknowledgedRevision === current.envelope.revision && (current.envelope.schema === 'PROFILE_ACTIVITY_SNAPSHOT_V3' || current.acknowledgedDigest === current.envelope.digest);
  if (acknowledged) return { status: 'acknowledged', state: current };
  if (current.attempts >= 4) return { status: 'retry-exhausted', state: current };
  const next = { ...current, attempts: current.attempts + 1 };
  return { status: 'send', envelope: next.envelope, state: next };
}

export function acceptAcknowledgement({ acknowledgement, state }) {
  const current = deliveryState(state);
  const v3 = current.envelope.schema === 'PROFILE_ACTIVITY_SNAPSHOT_V3';
  const keys = v3 ? 'revision,status' : 'digest,revision,status';
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement) || Object.keys(acknowledgement).sort().join(',') !== keys) throw new Error('invalid acknowledgement keys');
  if (!['received', 'acknowledged'].includes(acknowledgement.status) || !Number.isSafeInteger(acknowledgement.revision) || !v3 && !/^[0-9a-f]{64}$/.test(acknowledgement.digest)) throw new Error('invalid acknowledgement');
  if (acknowledgement.revision !== current.envelope.revision || !v3 && acknowledgement.digest !== current.envelope.digest) throw new Error('acknowledgement mismatch');
  return { ...current, acknowledgedRevision: acknowledgement.revision, acknowledgedDigest: v3 ? null : acknowledgement.digest };
}

export async function receiveEnvelope({ envelope: input, expectedSourceId, lastGoodFile, stateScope }) {
  const envelope = parseEnvelope(input);
  if (envelope.snapshot.schemaVersion !== 3 && envelope.snapshot.sourceId !== expectedSourceId) throw new Error('unregistered source');
  let current = null;
  try { current = await readSnapshot(lastGoodFile, stateScope); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current) {
    if (envelope.revision < current.revision) throw new Error('revision rollback');
    if (envelope.revision === current.revision) {
      if (stableJson(envelope.snapshot) !== stableJson(current)) throw new Error('revision conflict');
      return { status: 'acknowledged', revision: envelope.revision, ...(envelope.snapshot.schemaVersion === 3 ? {} : { digest: envelope.digest }) };
    }
  }
  await atomicWrite(lastGoodFile, envelope.snapshot, stateScope);
  return { status: 'received', revision: envelope.revision, ...(envelope.snapshot.schemaVersion === 3 ? {} : { digest: envelope.digest }) };
}
