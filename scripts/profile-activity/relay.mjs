import { parsePrivateSnapshot } from './contract.mjs';
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
