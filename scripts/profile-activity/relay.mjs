import { parseDate, parsePrivateSnapshot } from './contract.mjs';
import { atomicWrite, readSnapshot, snapshotDigest } from './snapshot.mjs';

const SCHEMA = 'PROFILE_ACTIVITY_SNAPSHOT_V2';

export function createEnvelope(value) {
  const snapshot = parsePrivateSnapshot(value);
  if (snapshot.schemaVersion !== 2) throw new Error('schema v2 required');
  return { schema: SCHEMA, revision: snapshot.revision, digest: snapshotDigest(snapshot), snapshot };
}

export function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
  if (Object.keys(value).sort().join(',') !== 'digest,revision,schema,snapshot') throw new Error('invalid envelope keys');
  const snapshot = parsePrivateSnapshot(value.snapshot);
  if (value.schema !== SCHEMA || snapshot.schemaVersion !== 2 || value.revision !== snapshot.revision) throw new Error('invalid envelope identity');
  if (!/^[0-9a-f]{64}$/.test(value.digest) || value.digest !== snapshotDigest(snapshot)) throw new Error('digest mismatch');
  return { schema: SCHEMA, revision: snapshot.revision, digest: value.digest, snapshot };
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
  const acknowledged = current.acknowledgedRevision === current.envelope.revision && current.acknowledgedDigest === current.envelope.digest;
  if (acknowledged) return { status: 'acknowledged', state: current };
  if (current.attempts >= 4) return { status: 'retry-exhausted', state: current };
  const next = { ...current, attempts: current.attempts + 1 };
  return { status: 'send', envelope: next.envelope, state: next };
}

export function acceptAcknowledgement({ acknowledgement, state }) {
  const current = deliveryState(state);
  if (!acknowledgement || !['received', 'acknowledged'].includes(acknowledgement.status)) throw new Error('invalid acknowledgement');
  if (acknowledgement.revision !== current.envelope.revision || acknowledgement.digest !== current.envelope.digest) throw new Error('acknowledgement mismatch');
  return { ...current, acknowledgedRevision: acknowledgement.revision, acknowledgedDigest: acknowledgement.digest };
}

export async function receiveEnvelope({ envelope: input, expectedSourceId, lastGoodFile, stateScope }) {
  const envelope = parseEnvelope(input);
  if (envelope.snapshot.sourceId !== expectedSourceId) throw new Error('unregistered source');
  let current = null;
  try { current = await readSnapshot(lastGoodFile, stateScope); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current) {
    if (envelope.revision < current.revision) throw new Error('revision rollback');
    if (envelope.revision === current.revision) {
      if (envelope.digest !== snapshotDigest(current)) throw new Error('revision conflict');
      return { status: 'acknowledged', revision: envelope.revision, digest: envelope.digest };
    }
  }
  await atomicWrite(lastGoodFile, envelope.snapshot, stateScope);
  return { status: 'received', revision: envelope.revision, digest: envelope.digest };
}
