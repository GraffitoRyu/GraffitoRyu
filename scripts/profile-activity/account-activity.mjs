const ROOT_KEYS_V1 = ['schemaVersion', 'observedDate', 'analytics', 'profile'];
const ROOT_KEYS_V2 = ['schemaVersion', 'observedDate', 'analytics', 'tokenUsage'];
const ANALYTICS_KEYS = ['readSucceeded', 'window', 'definition', 'grouping', 'refreshCadence', 'localComparable', 'automatedCollection', 'totals', 'days'];
const TOKEN_USAGE_KEYS = ['readSucceeded', 'window', 'definition', 'refreshCadence', 'localComparable', 'automatedCollection', 'summary', 'days'];
const TOKEN_SUMMARY_KEYS = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];
const METRIC_KEYS = ['turns', 'pluginCalls', 'skillUses'];

function parseDate(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${name}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`invalid ${name}`);
  return value;
}

function addDays(date, amount) {
  const value = new Date(`${parseDate(date)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`invalid ${name} keys`);
}

function count(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function parseWindow(value, name) {
  exactKeys(value, ['from', 'to'], `${name} window`);
  const window = { from: parseDate(value.from), to: parseDate(value.to) };
  if (addDays(window.from, 29) !== window.to) throw new Error(`${name} window must contain 30 days`);
  return window;
}

function parseAnalytics(value) {
  exactKeys(value, ANALYTICS_KEYS, 'analytics');
  if (value.readSucceeded !== true || value.definition !== 'personal-codex-and-work' || value.refreshCadence !== null || value.localComparable !== false || value.automatedCollection !== false || value.grouping !== 'daily') throw new Error('invalid analytics evidence');
  const window = parseWindow(value.window, 'analytics');
  exactKeys(value.totals, METRIC_KEYS, 'analytics totals');
  const totals = Object.fromEntries(METRIC_KEYS.map((key) => [key, count(value.totals[key], `analytics totals.${key}`)]));
  if (!Array.isArray(value.days) || value.days.length !== 30) throw new Error('invalid analytics days');
  const days = value.days.map((day, index) => {
    exactKeys(day, ['date', ...METRIC_KEYS], 'analytics day');
    const date = parseDate(day.date);
    if (date !== addDays(window.from, index)) throw new Error('analytics days must be contiguous');
    return { date, ...Object.fromEntries(METRIC_KEYS.map((key) => [key, count(day[key], `analytics day.${key}`, true)])) };
  });
  for (const key of METRIC_KEYS) {
    if (days.reduce((sum, day) => sum + (day[key] ?? 0), 0) !== totals[key]) throw new Error(`analytics ${key} total mismatch`);
  }
  return { ...value, window, totals, days };
}

export function parseAccountTokenUsage(value) {
  exactKeys(value, TOKEN_USAGE_KEYS, 'token usage');
  if (value.readSucceeded !== true || value.definition !== 'chatgpt-account-token-activity' || value.refreshCadence !== null || value.localComparable !== false || value.automatedCollection !== true) throw new Error('invalid token usage evidence');
  const window = parseWindow(value.window, 'token usage');
  exactKeys(value.summary, TOKEN_SUMMARY_KEYS, 'token usage summary');
  const summary = Object.fromEntries(TOKEN_SUMMARY_KEYS.map((key) => [key, count(value.summary[key], `token usage summary.${key}`, true)]));
  if (!Array.isArray(value.days) || value.days.length > 30) throw new Error('invalid token usage days');
  const seen = new Set();
  const days = value.days.map((day) => {
    exactKeys(day, ['date', 'tokens'], 'token usage day');
    const date = parseDate(day.date);
    if (date < window.from || date > window.to || seen.has(date)) throw new Error('invalid token usage day date');
    seen.add(date);
    return { date, tokens: count(day.tokens, 'token usage day.tokens') };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (summary.peakDailyTokens !== null && days.some(({ tokens }) => tokens > summary.peakDailyTokens)) throw new Error('token usage peak mismatch');
  return { ...value, window, summary, days };
}

export function parseAccountActivity(value) {
  if (value?.schemaVersion === 1) {
    exactKeys(value, ROOT_KEYS_V1, 'account activity');
    return { schemaVersion: 1, observedDate: parseDate(value.observedDate, 'observedDate'), analytics: parseAnalytics(value.analytics), profile: value.profile };
  }
  exactKeys(value, ROOT_KEYS_V2, 'account activity');
  if (value.schemaVersion !== 2) throw new Error('invalid account activity schema');
  return {
    schemaVersion: 2,
    observedDate: parseDate(value.observedDate, 'observedDate'),
    analytics: parseAnalytics(value.analytics),
    tokenUsage: parseAccountTokenUsage(value.tokenUsage),
  };
}

export function attachAccountTokenUsage(value, tokenUsage, observedDate) {
  const parsed = parseAccountActivity(value);
  return parseAccountActivity({ schemaVersion: 2, observedDate: parseDate(observedDate, 'observedDate'), analytics: parsed.analytics, tokenUsage });
}

export function mergeVerifiedMetric(local, account, { sameDefinition, samePeriod }) {
  const localValue = count(local, 'local metric', true);
  const accountValue = count(account, 'account metric', true);
  if (sameDefinition !== true || samePeriod !== true) return { value: null, source: 'separate' };
  if (accountValue === null) return { value: localValue, source: 'local' };
  if (localValue === null || localValue < accountValue) return { value: accountValue, source: 'account' };
  if (localValue > accountValue) throw new Error('metric contradiction');
  return { value: localValue, source: 'matched' };
}
