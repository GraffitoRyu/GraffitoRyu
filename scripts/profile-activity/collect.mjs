import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { addDays } from './contract.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const CACHE_VERSION = 2;

function typeOf(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function kstDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ value }) => value)
    .join('-');
}

async function listJsonl(root) {
  const resolvedRoot = await realpath(root);
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error('symlink in log scope');
      if (info.isDirectory()) await visit(candidate);
      else if (info.isFile() && entry.name.endsWith('.jsonl')) {
        const resolved = await realpath(candidate);
        if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('log path escaped scope');
        if (info.size > MAX_FILE_BYTES) throw new Error('log file exceeds size limit');
        files.push({ path: resolved, size: info.size, mtimeMs: info.mtimeMs, key: `${info.dev}:${info.ino}` });
      }
    }
  }
  await visit(resolvedRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function boundaryHash(file, offset) {
  const length = Math.min(4096, offset);
  if (length === 0) return createHash('sha256').digest('hex');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset - length);
    return createHash('sha256').update(buffer).digest('hex');
  } finally {
    await handle.close();
  }
}

async function scanFile(file, previous = undefined) {
  // ponytail: a 4 KiB boundary fingerprint avoids rescanning large unchanged files; use a full rolling digest if adversarial in-place rewrites become a real input.
  const boundaryMatches = previous?.boundaryHash === await boundaryHash(file.path, previous?.offset ?? 0);
  const append = previous?.cacheVersion === CACHE_VERSION && previous.offset <= file.size && boundaryMatches && (previous.offset < file.size || previous.mtimeMs === file.mtimeMs);
  const state = append
    ? { ...previous, events: [...previous.events], unknownDates: [...(previous.unknownDates ?? [])] }
    : { cacheVersion: CACHE_VERSION, offset: 0, sessionId: null, excluded: false, events: [], unknownDates: [], partial: false, historyStartOrdinal: null, unknownInheritance: false, forked: false, tokenBaseline: null, excludedRoots: previous?.excludedRoots ?? [] };
  if (state.offset === file.size) return state;
  const stream = createReadStream(file.path, { start: state.offset, end: file.size - 1, encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = state.offset;
  let lastCompleteOffset = state.offset;
  for await (const line of lines) {
    consumed += Buffer.byteLength(line) + 1;
    const complete = consumed <= file.size || file.size === 0;
    if (!complete) break;
    if (!line.trim()) {
      if (complete) lastCompleteOffset = Math.min(consumed, file.size);
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (consumed >= file.size) break;
      state.partial = true;
      lastCompleteOffset = Math.min(consumed, file.size);
      continue;
    }
    lastCompleteOffset = Math.min(consumed, file.size);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      state.partial = true;
      continue;
    }
    const payload = record.payload;
    if (record.type === 'session_meta' && payload && typeof payload === 'object') {
      const id = typeof payload.id === 'string' ? payload.id : null;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
      // session_id is the observed logical thread identity; id identifies a rollout segment.
      state.sessionId = sessionId ?? id;
      if (typeof payload.cwd === 'string' && state.excludedRoots?.some((root) => payload.cwd === root || payload.cwd.startsWith(`${root}${path.sep}`))) state.excluded = true;
      state.forked = typeof payload.forked_from_id === 'string' || typeof payload.parent_thread_id === 'string';
      if (Number.isSafeInteger(payload.subagent_history_start_ordinal)) state.historyStartOrdinal = payload.subagent_history_start_ordinal;
      else if (Number.isSafeInteger(payload.forked_from_ordinal_exclusive)) state.historyStartOrdinal = payload.forked_from_ordinal_exclusive + 1;
      else if (state.forked) state.unknownInheritance = true;
      const date = kstDate(record.timestamp);
      if (date && state.sessionId && !state.excluded) {
        const hash = createHash('sha256').update(`${state.sessionId}\0meta\0${record.timestamp}`).digest('hex');
        state.events.push({ date, timestamp: record.timestamp, sessionId: state.sessionId, kind: 'meta', callId: null, hash });
      }
      continue;
    }
    if (record.type === 'event_msg' && payload?.type === 'token_count') {
      const date = kstDate(record.timestamp);
      const totalTokens = payload.info?.total_token_usage?.total_tokens;
      if (state.excluded) continue;
      if (!date || !state.sessionId || !Number.isSafeInteger(totalTokens) || totalTokens < 0) {
        if (date) state.unknownDates.push(date);
        state.partial = true;
        continue;
      }
      if (state.unknownInheritance || (state.historyStartOrdinal !== null && !Number.isSafeInteger(record.ordinal))) {
        state.unknownDates.push(date);
        state.partial = true;
        continue;
      }
      if (state.historyStartOrdinal !== null && record.ordinal < state.historyStartOrdinal) continue;
      if (state.forked && state.tokenBaseline === null) state.tokenBaseline = totalTokens;
      const sessionTotal = Math.max(0, totalTokens - (state.tokenBaseline ?? 0));
      const stableId = Number.isSafeInteger(record.ordinal) ? record.ordinal : `${record.timestamp}\0${totalTokens}`;
      const hash = createHash('sha256').update(`${state.sessionId}\0token\0${stableId}`).digest('hex');
      state.events.push({ date, timestamp: record.timestamp, sessionId: state.sessionId, kind: 'tokens', callId: null, hash, sessionTotal });
      continue;
    }
    if (record.type !== 'response_item' || !payload || typeof payload !== 'object') continue;
    if (payload.inherited === true) continue;
    if (payload.provenance !== undefined && !['local', 'new'].includes(payload.provenance)) {
      state.partial = true;
      continue;
    }
    const itemType = payload.type;
    const eligibleMessage = itemType === 'message' && (payload.role === 'user' || payload.role === 'assistant');
    const eligibleCall = ['function_call', 'custom_tool_call', 'tool_call', 'tool_search_call', 'web_search_call'].includes(itemType);
    if (!eligibleMessage && !eligibleCall) continue;
    const date = kstDate(record.timestamp);
    if (state.unknownInheritance || (state.historyStartOrdinal !== null && !Number.isSafeInteger(record.ordinal))) {
      if (date) state.unknownDates.push(date);
      state.partial = true;
      continue;
    }
    if (state.historyStartOrdinal !== null && record.ordinal < state.historyStartOrdinal) continue;
    if (!date || !state.sessionId || state.excluded) {
      state.partial = true;
      continue;
    }
    const callId = eligibleCall ? (typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : null) : null;
    if (eligibleCall && !callId) {
      state.partial = true;
      continue;
    }
    const stableId = typeof payload.id === 'string' ? payload.id : line;
    const hash = createHash('sha256').update(`${state.sessionId}\0${stableId}`).digest('hex');
    state.events.push({ date, timestamp: record.timestamp, sessionId: state.sessionId, kind: eligibleCall ? 'tool' : 'activity', callId, hash });
  }
  state.offset = lastCompleteOffset;
  state.boundaryHash = await boundaryHash(file.path, state.offset);
  state.mtimeMs = file.mtimeMs;
  return state;
}

/** Probe returns field names, types, event kinds, and counts only. */
export async function probeLogRoots(logRoots) {
  const shapes = new Map();
  let files = 0;
  let validRecords = 0;
  let invalidRecords = 0;
  const identity = { bothEqual: 0, bothDifferent: 0, idOnly: 0, sessionIdOnly: 0, neither: 0 };
  const inheritance = { knownBoundary: 0, forkWithoutBoundary: 0, noFork: 0 };
  for (const root of logRoots) {
    for (const file of await listJsonl(root)) {
      files += 1;
      const stream = createReadStream(file.path, { end: Math.max(0, file.size - 1), encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
          validRecords += 1;
          const top = Object.keys(record).sort().map((key) => `${key}:${typeOf(record[key])}`).join(',');
          const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
            ? Object.keys(record.payload).sort().map((key) => `${key}:${typeOf(record.payload[key])}`).join(',')
            : 'none';
          const kind = typeof record.type === 'string' ? record.type : 'missing';
          const payloadKind = typeof record.payload?.type === 'string' ? record.payload.type : 'none';
          if (kind === 'session_meta') {
            const id = typeof record.payload?.id === 'string' ? record.payload.id : null;
            const sessionId = typeof record.payload?.session_id === 'string' ? record.payload.session_id : null;
            if (id && sessionId) identity[id === sessionId ? 'bothEqual' : 'bothDifferent'] += 1;
            else if (id) identity.idOnly += 1;
            else if (sessionId) identity.sessionIdOnly += 1;
            else identity.neither += 1;
            const fork = typeof record.payload?.forked_from_id === 'string' || typeof record.payload?.parent_thread_id === 'string';
            const boundary = Number.isSafeInteger(record.payload?.subagent_history_start_ordinal) || Number.isSafeInteger(record.payload?.forked_from_ordinal_exclusive);
            inheritance[boundary ? 'knownBoundary' : fork ? 'forkWithoutBoundary' : 'noFork'] += 1;
          }
          const key = `${kind}|${payloadKind}|${top}|${payload}`;
          shapes.set(key, (shapes.get(key) ?? 0) + 1);
        } catch {
          invalidRecords += 1;
        }
      }
    }
  }
  return {
    files,
    validRecords,
    invalidRecords,
    identity,
    inheritance,
    shapes: [...shapes].sort(([a], [b]) => a.localeCompare(b)).map(([shape, count]) => ({ shape, count })),
  };
}

export async function collectLogRoots({ logRoots, excludedRepoRoots = [], from, to, cache = { files: {} } }) {
  const files = [];
  for (const root of logRoots) files.push(...await listJsonl(root));
  const nextCache = { files: { ...cache.files } };
  for (const file of files) {
    const previous = nextCache.files[file.key];
    const seeded = previous ? { ...previous, excludedRoots: excludedRepoRoots } : { excludedRoots: excludedRepoRoots };
    const state = await scanFile(file, seeded);
    delete state.excludedRoots;
    nextCache.files[file.key] = state;
  }
  const eventHashes = new Set();
  const sessionDays = new Set();
  const callDays = new Set();
  const tokenEvents = [];
  const sessionBounds = new Map();
  const unknownDates = new Set();
  let partial = false;
  for (const state of Object.values(nextCache.files)) {
    partial ||= state.partial;
    for (const date of state.unknownDates ?? []) if (date >= from && date <= to) unknownDates.add(date);
    for (const event of state.events) {
      if (event.date < from || event.date > to || eventHashes.has(event.hash)) continue;
      eventHashes.add(event.hash);
      if (typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))) {
        const bounds = sessionBounds.get(event.sessionId) ?? { first: event.timestamp, last: event.timestamp, lastDate: event.date };
        if (event.timestamp < bounds.first) bounds.first = event.timestamp;
        if (event.timestamp > bounds.last) {
          bounds.last = event.timestamp;
          bounds.lastDate = event.date;
        }
        sessionBounds.set(event.sessionId, bounds);
      }
      if (event.kind === 'meta') continue;
      sessionDays.add(`${event.date}\0${event.sessionId}`);
      if (event.kind === 'tool') callDays.add(`${event.date}\0${event.sessionId}\0${event.callId}`);
      if (event.kind === 'tokens') tokenEvents.push(event);
    }
  }
  tokenEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const sessionTokenHigh = new Map();
  const tokensByDate = new Map();
  const maxSessionTokensByDate = new Map();
  for (const event of tokenEvents) {
    const previous = sessionTokenHigh.get(event.sessionId) ?? 0;
    const current = Math.max(previous, event.sessionTotal);
    tokensByDate.set(event.date, (tokensByDate.get(event.date) ?? 0) + current - previous);
    maxSessionTokensByDate.set(event.date, Math.max(maxSessionTokensByDate.get(event.date) ?? 0, current));
    sessionTokenHigh.set(event.sessionId, current);
  }
  const longestSessionByDate = new Map();
  for (const bounds of sessionBounds.values()) {
    const minutes = Math.max(0, Math.floor((Date.parse(bounds.last) - Date.parse(bounds.first)) / 60000));
    longestSessionByDate.set(bounds.lastDate, Math.max(longestSessionByDate.get(bounds.lastDate) ?? 0, minutes));
  }
  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const sessions = [...sessionDays].filter((key) => key.startsWith(`${date}\0`)).length;
    const toolCalls = [...callDays].filter((key) => key.startsWith(`${date}\0`)).length;
    days.push(unknownDates.has(date)
      ? { date, active: sessions > 0 ? true : null, activeSessions: null, toolCalls: null, tokens: null, maxSessionTokens: null, longestSessionMinutes: null, coverage: sessions > 0 ? 'partial' : 'unknown' }
      : { date, active: sessions > 0, activeSessions: sessions, toolCalls, tokens: tokensByDate.get(date) ?? 0, maxSessionTokens: maxSessionTokensByDate.get(date) ?? 0, longestSessionMinutes: longestSessionByDate.get(date) ?? 0, coverage: partial ? 'partial' : 'complete' });
  }
  return { days, cache: nextCache, partial, files: files.length };
}
