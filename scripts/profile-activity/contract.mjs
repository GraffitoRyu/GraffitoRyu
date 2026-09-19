const PRIVATE_KEYS = ['schemaVersion', 'sourceId', 'revision', 'policyId', 'collectedAt', 'timezone', 'window', 'days'];
const PUBLIC_KEYS = ['schemaVersion', 'metricScope', 'timezone', 'window', 'asOfDate', 'completeThroughDate', 'status', 'summary', 'days'];
const PROFILE_PUBLIC_KEYS = [...PUBLIC_KEYS, 'aggregation'];
const DAY_KEYS = ['date', 'active', 'activeSessions', 'toolCalls', 'coverage'];
const PROFILE_DAY_KEYS = [...DAY_KEYS, 'tokens', 'maxSessionTokens', 'longestSessionMinutes'];
const SURFACE_DAY_KEYS = [...PROFILE_DAY_KEYS, 'newChats', 'pluginCalls', 'browserCalls', 'computerUseCalls', 'otherToolCalls', 'skillUses', 'fastTurns', 'modeTurns', 'reasoningTurns', 'reasoning'];
const REASONING_KEYS = ['none', 'low', 'medium', 'high', 'xhigh', 'other'];
const WINDOW_KEYS = ['from', 'to'];
const SUMMARY_KEYS = ['activeDays', 'sessionDays', 'toolCalls'];
const PROFILE_SUMMARY_KEYS = [...SUMMARY_KEYS, 'totalTokens', 'maxSessionTokens', 'longestSessionMinutes', 'currentStreakDays', 'longestStreakDays'];
const COVERAGE = new Set(['complete', 'partial', 'unknown']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(object(value, name)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid ${name} keys`);
  }
}

export function parseDate(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${name}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`invalid ${name}`);
  return value;
}

export function addDays(date, amount) {
  const value = new Date(`${parseDate(date)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function nullableCount(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function parseWindow(value) {
  exactKeys(value, WINDOW_KEYS, 'window');
  const from = parseDate(value.from, 'window.from');
  const to = parseDate(value.to, 'window.to');
  if (from > to) throw new Error('invalid window order');
  return { from, to };
}

function parseDays(value, window, schemaVersion = 1) {
  if (!Array.isArray(value)) throw new Error('invalid days');
  const expectedLength = Math.round((new Date(`${window.to}T00:00:00Z`) - new Date(`${window.from}T00:00:00Z`)) / 86400000) + 1;
  if (value.length !== expectedLength) throw new Error('incomplete days window');
  return value.map((day, index) => {
    const profile = schemaVersion >= 2;
    exactKeys(day, schemaVersion === 3 ? SURFACE_DAY_KEYS : profile ? PROFILE_DAY_KEYS : DAY_KEYS, 'day');
    const date = parseDate(day.date);
    if (date !== addDays(window.from, index)) throw new Error('days must be contiguous');
    if (day.active !== null && typeof day.active !== 'boolean') throw new Error('invalid active');
    const activeSessions = nullableCount(day.activeSessions, 'activeSessions');
    const toolCalls = nullableCount(day.toolCalls, 'toolCalls');
    if (!COVERAGE.has(day.coverage)) throw new Error('invalid coverage');
    if (day.coverage === 'unknown' && (day.active !== null || activeSessions !== null || toolCalls !== null)) throw new Error('unknown day has values');
    if (!profile) return { date, active: day.active, activeSessions, toolCalls, coverage: day.coverage };
    const tokens = nullableCount(day.tokens, 'tokens');
    const maxSessionTokens = nullableCount(day.maxSessionTokens, 'maxSessionTokens');
    const longestSessionMinutes = nullableCount(day.longestSessionMinutes, 'longestSessionMinutes');
    if (day.coverage === 'unknown' && [tokens, maxSessionTokens, longestSessionMinutes].some((item) => item !== null)) throw new Error('unknown day has profile values');
    if (schemaVersion !== 3) return { date, active: day.active, activeSessions, toolCalls, tokens, maxSessionTokens, longestSessionMinutes, coverage: day.coverage };
    const counts = Object.fromEntries(['newChats', 'pluginCalls', 'browserCalls', 'computerUseCalls', 'otherToolCalls', 'skillUses', 'fastTurns', 'modeTurns', 'reasoningTurns'].map((key) => [key, nullableCount(day[key], key)]));
    if ((counts.fastTurns === null) !== (counts.modeTurns === null) || counts.fastTurns !== null && counts.fastTurns > counts.modeTurns) throw new Error('invalid fastTurns denominator');
    let reasoning = null;
    if (day.reasoning !== null) {
      exactKeys(day.reasoning, REASONING_KEYS, 'reasoning');
      reasoning = Object.fromEntries(REASONING_KEYS.map((key) => [key, nullableCount(day.reasoning[key], `reasoning.${key}`)]));
      if (Object.values(reasoning).some((count) => count === null)) throw new Error('invalid reasoning count');
    }
    if ((counts.reasoningTurns === null) !== (reasoning === null) || reasoning && counts.reasoningTurns !== Object.values(reasoning).reduce((sum, count) => sum + count, 0)) throw new Error('invalid reasoningTurns denominator');
    if (day.coverage === 'unknown' && [...Object.values(counts), reasoning].some((item) => item !== null)) throw new Error('unknown day has surface values');
    return { date, active: day.active, activeSessions, newChats: counts.newChats, toolCalls, pluginCalls: counts.pluginCalls, browserCalls: counts.browserCalls, computerUseCalls: counts.computerUseCalls, otherToolCalls: counts.otherToolCalls, skillUses: counts.skillUses, tokens, maxSessionTokens, longestSessionMinutes, fastTurns: counts.fastTurns, modeTurns: counts.modeTurns, reasoningTurns: counts.reasoningTurns, reasoning, coverage: day.coverage };
  });
}

export function parsePrivateSnapshot(value) {
  exactKeys(value, PRIVATE_KEYS, 'private snapshot');
  if (![1, 2, 3].includes(value.schemaVersion)) throw new Error('unsupported private schema');
  if (typeof value.sourceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sourceId)) throw new Error('invalid sourceId');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('invalid revision');
  if (value.policyId !== 'local-codex-v1-kst-exclude-profile') throw new Error('invalid policyId');
  if (value.timezone !== 'Asia/Seoul') throw new Error('invalid timezone');
  if (typeof value.collectedAt !== 'string' || Number.isNaN(Date.parse(value.collectedAt))) throw new Error('invalid collectedAt');
  const window = parseWindow(value.window);
  if (value.schemaVersion === 3 && addDays(window.from, 29) !== window.to) throw new Error('private v3 window must contain 30 days');
  const days = parseDays(value.days, window, value.schemaVersion);
  return { schemaVersion: value.schemaVersion, sourceId: value.sourceId, revision: value.revision, policyId: value.policyId, collectedAt: new Date(value.collectedAt).toISOString(), timezone: value.timezone, window, days };
}

export function parsePublicActivity(value) {
  const profile = value?.schemaVersion === 2;
  exactKeys(value, profile ? PROFILE_PUBLIC_KEYS : PUBLIC_KEYS, 'public activity');
  if (![1, 2].includes(value.schemaVersion) || value.metricScope !== 'observed-local-codex' || value.timezone !== 'Asia/Seoul') throw new Error('invalid public identity');
  const window = parseWindow(value.window);
  if (addDays(window.from, 29) !== window.to) throw new Error('public window must contain 30 days');
  const asOfDate = parseDate(value.asOfDate, 'asOfDate');
  if (asOfDate !== window.to) throw new Error('asOfDate must equal window.to');
  const completeThroughDate = value.completeThroughDate === null ? null : parseDate(value.completeThroughDate, 'completeThroughDate');
  if (completeThroughDate && (completeThroughDate < window.from || completeThroughDate > window.to)) throw new Error('invalid completeThroughDate range');
  if (!new Set(['ready', 'partial', 'unavailable']).has(value.status)) throw new Error('invalid status');
  exactKeys(value.summary, profile ? PROFILE_SUMMARY_KEYS : SUMMARY_KEYS, 'summary');
  const summary = {
    activeDays: nullableCount(value.summary.activeDays, 'summary.activeDays'),
    sessionDays: nullableCount(value.summary.sessionDays, 'summary.sessionDays'),
    toolCalls: nullableCount(value.summary.toolCalls, 'summary.toolCalls'),
  };
  if (profile) {
    if (!['sum', 'lower-bound'].includes(value.aggregation)) throw new Error('invalid aggregation');
    for (const key of PROFILE_SUMMARY_KEYS.slice(3)) summary[key] = nullableCount(value.summary[key], `summary.${key}`);
  }
  return { schemaVersion: value.schemaVersion, metricScope: value.metricScope, timezone: value.timezone, window, asOfDate, completeThroughDate, status: value.status, ...(profile && { aggregation: value.aggregation }), summary, days: parseDays(value.days, window, value.schemaVersion) };
}

export function isPublishableActivity(value) {
  return parsePublicActivity(value).status !== 'unavailable';
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
