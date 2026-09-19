import { parseRepositoryCollection } from './contract.mjs';

const COLLECTION_PATHS = {
  macbook: 'metrics/codex-activity-macbook.json',
  macmini: 'metrics/codex-activity-macmini.json',
};

export function collectionPath(slot) {
  if (!Object.hasOwn(COLLECTION_PATHS, slot)) throw new Error('invalid collection slot');
  return COLLECTION_PATHS[slot];
}

export function createRepositoryCollection(snapshot) {
  return parseRepositoryCollection(snapshot);
}
