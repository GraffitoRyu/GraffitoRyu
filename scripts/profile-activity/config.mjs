import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { COLLECTION_PATHS } from './collection.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`invalid ${name}`);
  return path.normalize(value);
}

function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`invalid ${name}`);
}

export function parseConfig(value) {
  const allowed = ['schemaVersion', 'role', 'sourceId', 'policyId', 'codexHome', 'logRoots', 'stateDir', 'transportDir', 'runtimeDir', 'runtimeManifest', 'excludedRepoRoots', 'expectedSources', 'independentSources', 'publicDays', 'retentionDays', 'staleAfterHours', 'timezone', 'publisher', 'launchAgent'];
  keys(value, allowed, 'config');
  if (value.schemaVersion !== 1 || !['collector', 'publisher'].includes(value.role)) throw new Error('invalid config identity');
  if (!UUID.test(value.sourceId) || value.policyId !== 'local-codex-v1-kst-exclude-profile' || value.timezone !== 'Asia/Seoul') throw new Error('invalid config policy');
  if (!Array.isArray(value.logRoots) || value.logRoots.length < 1 || !Array.isArray(value.excludedRepoRoots)) throw new Error('invalid config roots');
  if (!value.runtimeManifest || typeof value.runtimeManifest !== 'object' || Array.isArray(value.runtimeManifest) || Object.entries(value.runtimeManifest).some(([name, digest]) => path.isAbsolute(name) || name.split(path.sep).includes('..') || !/^[0-9a-f]{64}$/.test(digest))) throw new Error('invalid runtimeManifest');
  if (![value.publicDays, value.retentionDays, value.staleAfterHours].every(Number.isSafeInteger) || value.publicDays !== 30 || value.retentionDays !== 90 || value.staleAfterHours < 1) throw new Error('invalid config limits');
  if (!Array.isArray(value.expectedSources) || value.expectedSources.length > 2) throw new Error('invalid expectedSources');
  const expectedSources = value.expectedSources.map((source) => {
    keys(source, ['sourceId', 'location', 'file'], 'expected source');
    if (!UUID.test(source.sourceId) || !['local', 'transport'].includes(source.location)) throw new Error('invalid expected source');
    return { sourceId: source.sourceId, location: source.location, file: absolute(source.file, 'source file') };
  });
  if (new Set(expectedSources.map(({ sourceId }) => sourceId)).size !== expectedSources.length) throw new Error('duplicate expected source');
  if (expectedSources.some(({ location }) => location === 'transport') && value.transportDir === null) throw new Error('transport source without transportDir');
  const directPublication = value.publisher?.collectionPath !== undefined;
  if (value.role === 'publisher' && !directPublication && (expectedSources.length !== 2 || !expectedSources.some(({ sourceId }) => sourceId === value.sourceId))) throw new Error('publisher requires two sources including itself');
  if (directPublication && (value.transportDir !== null || expectedSources.length !== 0)) throw new Error('direct publication cannot use transport sources');
  if (typeof value.independentSources !== 'boolean') throw new Error('invalid independentSources');
  if (value.publisher !== undefined) {
    keys(value.publisher, ['repoDir', 'remote', 'branch', 'candidateRoot', 'retryLimit', 'hooksPath', 'hooksManifest', 'collectionPath'], 'publisher');
    if (typeof value.publisher.remote !== 'string' || typeof value.publisher.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.publisher.branch) || value.publisher.branch.includes('..') || !Number.isSafeInteger(value.publisher.retryLimit) || value.publisher.retryLimit < 0 || value.publisher.retryLimit > 2 || typeof value.publisher.hooksPath !== 'string' || (value.publisher.hooksPath !== '' && !path.isAbsolute(value.publisher.hooksPath))) throw new Error('invalid publisher');
    if (value.publisher.collectionPath !== undefined && !COLLECTION_PATHS.includes(value.publisher.collectionPath)) throw new Error('invalid collectionPath');
    if (value.publisher.hooksManifest !== undefined) {
      if (!value.publisher.hooksManifest || typeof value.publisher.hooksManifest !== 'object' || Array.isArray(value.publisher.hooksManifest)) throw new Error('invalid hooksManifest');
      for (const [name, entry] of Object.entries(value.publisher.hooksManifest)) {
        if (!name || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('invalid hook path');
        keys(entry, ['digest', 'mode'], 'hook entry');
        if (!/^[0-9a-f]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('invalid hook entry');
      }
    }
  }
  if (value.role === 'publisher' && !value.publisher) throw new Error('publisher config required');
  if (value.launchAgent !== undefined) {
    if (value.role !== 'collector') throw new Error('publisher cannot own collector launch agent');
    keys(value.launchAgent, ['label', 'plistFile'], 'launchAgent');
    if (value.launchAgent.label !== 'com.graffitoryu.profile-activity.collector') throw new Error('invalid launchAgent label');
  }
  const codexHome = absolute(value.codexHome, 'codexHome');
  const logRoots = value.logRoots.map((item) => absolute(item, 'logRoot'));
  if (logRoots.some((root) => root !== codexHome && !root.startsWith(`${codexHome}${path.sep}`))) throw new Error('logRoot outside codexHome');
  return {
    ...value,
    codexHome,
    logRoots,
    stateDir: absolute(value.stateDir, 'stateDir'),
    transportDir: value.transportDir === null ? null : absolute(value.transportDir, 'transportDir'),
    runtimeDir: absolute(value.runtimeDir, 'runtimeDir'),
    excludedRepoRoots: value.excludedRepoRoots.map((item) => absolute(item, 'excludedRepoRoot')),
    expectedSources,
    launchAgent: value.launchAgent && { ...value.launchAgent, plistFile: absolute(value.launchAgent.plistFile, 'plistFile') },
    publisher: value.publisher && { ...value.publisher, repoDir: absolute(value.publisher.repoDir, 'repoDir'), candidateRoot: absolute(value.publisher.candidateRoot, 'candidateRoot') },
  };
}

export async function readConfig(file) {
  return parseConfig(JSON.parse(await readFile(file, 'utf8')));
}
