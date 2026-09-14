const PRIVATE_KEYS = ['schemaVersion', 'sourceId', 'revision', 'policyId', 'collectedAt', 'timezone', 'window', 'days'];
const PUBLIC_KEYS = ['schemaVersion', 'metricScope', 'timezone', 'window', 'asOfDate', 'completeThroughDate', 'status', 'summary', 'days'];
const DAY_KEYS = ['date', 'active', 'activeSessions', 'toolCalls', 'coverage'];
const WINDOW_KEYS = ['from', 'to'];
const SUMMARY_KEYS = ['activeDays', 'sessionDays', 'toolCalls'];
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

function parseDays(value, window) {
  if (!Array.isArray(value)) throw new Error('invalid days');
  const expectedLength = Math.round((new Date(`${window.to}T00:00:00Z`) - new Date(`${window.from}T00:00:00Z`)) / 86400000) + 1;
  if (value.length !== expectedLength) throw new Error('incomplete days window');
  return value.map((day, index) => {
    exactKeys(day, DAY_KEYS, 'day');
    const date = parseDate(day.date);
    if (date !== addDays(window.from, index)) throw new Error('days must be contiguous');
    if (day.active !== null && typeof day.active !== 'boolean') throw new Error('invalid active');
    const activeSessions = nullableCount(day.activeSessions, 'activeSessions');
    const toolCalls = nullableCount(day.toolCalls, 'toolCalls');
    if (!COVERAGE.has(day.coverage)) throw new Error('invalid coverage');
    if (day.coverage === 'unknown' && (day.active !== null || activeSessions !== null || toolCalls !== null)) throw new Error('unknown day has values');
    return { date, active: day.active, activeSessions, toolCalls, coverage: day.coverage };
  });
}

export function parsePrivateSnapshot(value) {
  exactKeys(value, PRIVATE_KEYS, 'private snapshot');
  if (value.schemaVersion !== 1) throw new Error('unsupported private schema');
  if (typeof value.sourceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sourceId)) throw new Error('invalid sourceId');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('invalid revision');
  if (value.policyId !== 'local-codex-v1-kst-exclude-profile') throw new Error('invalid policyId');
  if (value.timezone !== 'Asia/Seoul') throw new Error('invalid timezone');
  if (typeof value.collectedAt !== 'string' || Number.isNaN(Date.parse(value.collectedAt))) throw new Error('invalid collectedAt');
  const window = parseWindow(value.window);
  const days = parseDays(value.days, window);
  return { schemaVersion: 1, sourceId: value.sourceId, revision: value.revision, policyId: value.policyId, collectedAt: new Date(value.collectedAt).toISOString(), timezone: value.timezone, window, days };
}

export function parsePublicActivity(value) {
  exactKeys(value, PUBLIC_KEYS, 'public activity');
  if (value.schemaVersion !== 1 || value.metricScope !== 'observed-local-codex' || value.timezone !== 'Asia/Seoul') throw new Error('invalid public identity');
  const window = parseWindow(value.window);
  if (addDays(window.from, 29) !== window.to) throw new Error('public window must contain 30 days');
  const asOfDate = parseDate(value.asOfDate, 'asOfDate');
  if (asOfDate !== window.to) throw new Error('asOfDate must equal window.to');
  const completeThroughDate = value.completeThroughDate === null ? null : parseDate(value.completeThroughDate, 'completeThroughDate');
  if (completeThroughDate && (completeThroughDate < window.from || completeThroughDate > window.to)) throw new Error('invalid completeThroughDate range');
  if (!new Set(['ready', 'partial', 'unavailable']).has(value.status)) throw new Error('invalid status');
  exactKeys(value.summary, SUMMARY_KEYS, 'summary');
  const summary = {
    activeDays: nullableCount(value.summary.activeDays, 'summary.activeDays'),
    sessionDays: nullableCount(value.summary.sessionDays, 'summary.sessionDays'),
    toolCalls: nullableCount(value.summary.toolCalls, 'summary.toolCalls'),
  };
  return { schemaVersion: 1, metricScope: value.metricScope, timezone: value.timezone, window, asOfDate, completeThroughDate, status: value.status, summary, days: parseDays(value.days, window) };
}

export function isPublishableActivity(value) {
  return parsePublicActivity(value).status !== 'unavailable';
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
