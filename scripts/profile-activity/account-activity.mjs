const ROOT_KEYS = ['schemaVersion', 'observedDate', 'analytics', 'profile'];
const ANALYTICS_KEYS = ['readSucceeded', 'window', 'definition', 'grouping', 'refreshCadence', 'localComparable', 'automatedCollection', 'totals', 'days'];
const PROFILE_KEYS = ['readSucceeded', 'definition', 'refreshCadence', 'localComparable', 'automatedCollection', 'tokenDay'];
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

function fixedEvidence(value, name, definition) {
  if (value.readSucceeded !== true || value.definition !== definition || value.refreshCadence !== null || value.localComparable !== false || value.automatedCollection !== false) throw new Error(`invalid ${name} evidence`);
}

export function parseAccountActivity(value) {
  exactKeys(value, ROOT_KEYS, 'account activity');
  if (value.schemaVersion !== 1) throw new Error('invalid account activity schema');
  const observedDate = parseDate(value.observedDate, 'observedDate');

  exactKeys(value.analytics, ANALYTICS_KEYS, 'analytics');
  fixedEvidence(value.analytics, 'analytics', 'personal-codex-and-work');
  if (value.analytics.grouping !== 'daily') throw new Error('invalid analytics grouping');
  exactKeys(value.analytics.window, ['from', 'to'], 'analytics window');
  const window = { from: parseDate(value.analytics.window.from), to: parseDate(value.analytics.window.to) };
  if (addDays(window.from, 29) !== window.to) throw new Error('analytics window must contain 30 days');
  exactKeys(value.analytics.totals, METRIC_KEYS, 'analytics totals');
  const totals = Object.fromEntries(METRIC_KEYS.map((key) => [key, count(value.analytics.totals[key], `analytics totals.${key}`)]));
  if (!Array.isArray(value.analytics.days) || value.analytics.days.length !== 30) throw new Error('invalid analytics days');
  const days = value.analytics.days.map((day, index) => {
    exactKeys(day, ['date', ...METRIC_KEYS], 'analytics day');
    const date = parseDate(day.date);
    if (date !== addDays(window.from, index)) throw new Error('analytics days must be contiguous');
    return { date, ...Object.fromEntries(METRIC_KEYS.map((key) => [key, count(day[key], `analytics day.${key}`, true)])) };
  });
  for (const key of METRIC_KEYS) {
    const observed = days.reduce((sum, day) => sum + (day[key] ?? 0), 0);
    if (observed !== totals[key]) throw new Error(`analytics ${key} total mismatch`);
  }

  exactKeys(value.profile, PROFILE_KEYS, 'profile');
  fixedEvidence(value.profile, 'profile', 'profile-daily-tokens');
  exactKeys(value.profile.tokenDay, ['date', 'displayValue', 'scale', 'precision'], 'profile token day');
  const tokenDate = parseDate(value.profile.tokenDay.date, 'profile token date');
  if (typeof value.profile.tokenDay.displayValue !== 'number' || !Number.isFinite(value.profile.tokenDay.displayValue) || value.profile.tokenDay.displayValue < 0 || value.profile.tokenDay.scale !== 100000000 || value.profile.tokenDay.precision !== 'rounded-display') throw new Error('invalid profile token display');

  return {
    schemaVersion: 1,
    observedDate,
    analytics: { ...value.analytics, window, totals, days },
    profile: { ...value.profile, tokenDay: { ...value.profile.tokenDay, date: tokenDate } },
  };
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
