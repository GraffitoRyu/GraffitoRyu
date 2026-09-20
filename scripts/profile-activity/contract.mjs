const ROOT_KEYS = ['schemaVersion', 'metricScope', 'timezone', 'window', 'asOfDate', 'summary', 'days'];
const SUMMARY_KEYS = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`invalid ${name} keys`);
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
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

function parseWindow(value) {
  exactKeys(value, ['from', 'to'], 'window');
  const window = { from: parseDate(value.from), to: parseDate(value.to) };
  if (addDays(window.from, 29) !== window.to) throw new Error('window must contain 30 days');
  return window;
}

export function parsePublicActivity(value) {
  exactKeys(value, ROOT_KEYS, 'public activity');
  if (value.schemaVersion !== 6 || value.metricScope !== 'codex-account-token-activity' || value.timezone !== 'Asia/Seoul') throw new Error('invalid public identity');
  const window = parseWindow(value.window);
  if (parseDate(value.asOfDate, 'asOfDate') !== window.to) throw new Error('asOfDate must equal window.to');
  exactKeys(value.summary, SUMMARY_KEYS, 'summary');
  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, count(value.summary[key], `summary.${key}`)]));
  if (!Array.isArray(value.days) || value.days.length !== 30) throw new Error('days must contain 30 entries');
  const days = value.days.map((day, index) => {
    exactKeys(day, ['date', 'tokens'], 'day');
    const date = parseDate(day.date);
    if (date !== addDays(window.from, index)) throw new Error('days must be contiguous');
    return { date, tokens: count(day.tokens, 'day.tokens') };
  });
  if (days.some(({ tokens }) => tokens > summary.peakDailyTokens)) throw new Error('peak daily tokens mismatch');
  return { schemaVersion: 6, metricScope: value.metricScope, timezone: value.timezone, window, asOfDate: value.asOfDate, summary, days };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
