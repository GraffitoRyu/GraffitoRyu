import { aggregateSnapshots } from './aggregate.mjs';

const KEYS = ['observedAt', 'window', 'rateLimitStatus', 'creditAvailable', 'creditUnlimited', 'coverage'];
const WINDOW_KEYS = ['durationMinutes', 'usedPercent', 'resetsAt'];
const COVERAGE = new Set(['complete', 'partial', 'unknown']);
const RATE_LIMIT = new Set(['ok', 'limited', 'exhausted', 'unknown']);

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`invalid ${name} keys`);
}

function instant(value, name) {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`invalid ${name}`);
  return new Date(value).toISOString();
}

export function parseAccountUsage(value) {
  exactKeys(value, KEYS, 'account usage');
  exactKeys(value.window, WINDOW_KEYS, 'account usage window');
  if (value.observedAt === null) throw new Error('invalid observedAt');
  const observedAt = instant(value.observedAt, 'observedAt');
  const durationMinutes = value.window.durationMinutes;
  if (durationMinutes !== null && (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1)) throw new Error('invalid durationMinutes');
  const usedPercent = value.window.usedPercent;
  if (usedPercent !== null && (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)) throw new Error('invalid usedPercent');
  const resetsAt = instant(value.window.resetsAt, 'resetsAt');
  if (!RATE_LIMIT.has(value.rateLimitStatus)) throw new Error('invalid rateLimitStatus');
  if (![true, false, null].includes(value.creditAvailable) || ![true, false, null].includes(value.creditUnlimited) || value.creditUnlimited === true && value.creditAvailable !== true) throw new Error('invalid credit flags');
  if (!COVERAGE.has(value.coverage)) throw new Error('invalid account usage coverage');
  if (value.coverage === 'complete' && [durationMinutes, usedPercent, resetsAt, value.creditAvailable, value.creditUnlimited].some((item) => item === null)) throw new Error('incomplete account usage');
  if (value.coverage === 'unknown' && [durationMinutes, usedPercent, resetsAt, value.creditAvailable, value.creditUnlimited].some((item) => item !== null)) throw new Error('unknown account usage has values');
  return { observedAt, window: { durationMinutes, usedPercent, resetsAt }, rateLimitStatus: value.rateLimitStatus, creditAvailable: value.creditAvailable, creditUnlimited: value.creditUnlimited, coverage: value.coverage };
}

export function processActivitySurface(snapshots, options, accountUsage = null) {
  const activity = aggregateSnapshots(snapshots, options);
  return { activity, accountUsage: accountUsage === null ? null : parseAccountUsage(accountUsage) };
}
