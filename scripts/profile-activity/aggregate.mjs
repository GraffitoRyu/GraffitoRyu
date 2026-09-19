import { addDays, parseDate, parsePublicActivity } from './contract.mjs';
import { chooseLatestSnapshots } from './snapshot.mjs';

const REASONING_KEYS = ['none', 'low', 'medium', 'high', 'xhigh', 'other'];

function percentage(numerator, denominator) {
  return denominator === 0 ? null : Math.round(numerator / denominator * 1000) / 10;
}

export function aggregateSnapshots(inputs, options) {
  const asOfDate = parseDate(options.asOfDate, 'asOfDate');
  if (!Array.isArray(options.expectedSourceIds) || options.expectedSourceIds.length !== 2 || new Set(options.expectedSourceIds).size !== 2) throw new Error('exactly two sources required');
  const referenceTime = new Date(options.referenceTime);
  if (Number.isNaN(referenceTime.valueOf())) throw new Error('invalid referenceTime');
  const selected = chooseLatestSnapshots(inputs, options.expectedSourceIds);
  const snapshots = selected.map(({ snapshot }) => snapshot);
  if (snapshots.some((snapshot) => new Date(snapshot.collectedAt) - referenceTime > 5 * 60 * 1000)) throw new Error('snapshot is too far in the future');
  const from = addDays(asOfDate, -29);
  const versions = new Set(snapshots.map(({ schemaVersion }) => schemaVersion));
  const surface = snapshots.length === 2 && versions.size === 1 && versions.has(3);
  if (surface && options.independentSources !== true) throw new Error('independent sources required for v3');
  const profile = surface || snapshots.length === 2 && versions.size === 1 && versions.has(2);
  const aggregation = options.independentSources === true ? 'sum' : 'lower-bound';
  const combine = (values) => aggregation === 'sum' ? values.reduce((sum, value) => sum + value, 0) : Math.max(...values);
  const bySource = new Map(selected.map(({ sourceId, snapshot }) => [sourceId, new Map(snapshot.days.map((day) => [day.date, day]))]));
  const days = [];
  for (let date = from; date <= asOfDate; date = addDays(date, 1)) {
    const sourceDays = options.expectedSourceIds.map((id) => bySource.get(id)?.get(date));
    const allKnown = sourceDays.every((day) => day && day.coverage !== 'unknown');
    const anyActive = sourceDays.some((day) => day?.active === true);
    const allInactive = sourceDays.every((day) => day?.active === false);
    const active = anyActive ? true : allInactive ? false : null;
    const values = (key) => sourceDays.map((day) => day[key]);
    const known = (key) => allKnown && sourceDays.every((day) => day[key] !== null);
    const legacyKeys = profile ? ['activeSessions', 'toolCalls', 'tokens', 'maxSessionTokens', 'longestSessionMinutes'] : ['activeSessions', 'toolCalls'];
    const legacyKnown = allKnown && (profile || options.independentSources === true) && sourceDays.every((day) => legacyKeys.every((key) => day[key] !== null));
    const complete = sourceDays.every((day) => day?.coverage === 'complete') && (options.independentSources === true || !profile);
    const coverage = complete ? 'complete' : sourceDays.some((day) => day && day.coverage !== 'unknown') ? 'partial' : 'unknown';
    const base = {
      date,
      active,
      activeSessions: legacyKnown ? combine(values('activeSessions')) : null,
      toolCalls: legacyKnown ? combine(values('toolCalls')) : null,
    };
    if (profile) Object.assign(base, {
      tokens: legacyKnown ? combine(values('tokens')) : null,
      maxSessionTokens: legacyKnown ? Math.max(...values('maxSessionTokens')) : null,
      longestSessionMinutes: legacyKnown ? Math.max(...values('longestSessionMinutes')) : null,
    });
    if (surface) {
      const reasoningKnown = known('reasoningTurns') && sourceDays.every((day) => day.reasoning !== null);
      const reasoningTurns = reasoningKnown ? values('reasoningTurns').reduce((sum, value) => sum + value, 0) : null;
      const reasoningPercent = reasoningTurns
        ? Object.fromEntries(REASONING_KEYS.map((key) => [key, percentage(sourceDays.reduce((sum, day) => sum + day.reasoning[key], 0), reasoningTurns)]))
        : null;
      const modeKnown = known('fastTurns') && known('modeTurns');
      Object.assign(base, {
        newChats: known('newChats') ? combine(values('newChats')) : null,
        pluginCalls: known('pluginCalls') ? combine(values('pluginCalls')) : null,
        browserCalls: known('browserCalls') ? combine(values('browserCalls')) : null,
        computerUseCalls: known('computerUseCalls') ? combine(values('computerUseCalls')) : null,
        otherToolCalls: known('otherToolCalls') ? combine(values('otherToolCalls')) : null,
        skillUses: known('skillUses') ? combine(values('skillUses')) : null,
        fastModePercent: modeKnown ? percentage(combine(values('fastTurns')), combine(values('modeTurns'))) : null,
        reasoningPercent,
      });
    }
    days.push({ ...base, coverage });
  }
  const fresh = snapshots.length === 2 && snapshots.every((snapshot) => referenceTime - new Date(snapshot.collectedAt) <= (options.staleAfterHours ?? 36) * 3600000);
  let completeThroughDate = null;
  for (const day of days) {
    if (day.coverage !== 'complete') break;
    completeThroughDate = day.date;
  }
  const every = (key) => days.every((day) => day[key] !== null);
  const lowerBound = profile && aggregation === 'lower-bound';
  const knownValues = (key) => days.map((day) => day[key]).filter((value) => value !== null);
  const total = (key) => every(key) || lowerBound && knownValues(key).length ? knownValues(key).reduce((sum, value) => sum + value, 0) : null;
  const maximum = (key) => every(key) || lowerBound && knownValues(key).length ? Math.max(...knownValues(key)) : null;
  const summary = {
    activeDays: every('active') || lowerBound && knownValues('active').length ? days.filter((day) => day.active).length : null,
    sessionDays: total('activeSessions'),
    toolCalls: total('toolCalls'),
  };
  if (profile) {
    const activeKnown = every('active') || lowerBound && knownValues('active').length;
    let currentStreakDays = activeKnown ? 0 : null;
    let longestStreakDays = activeKnown ? 0 : null;
    let run = 0;
    if (activeKnown) {
      for (const day of days) {
        run = day.active ? run + 1 : 0;
        longestStreakDays = Math.max(longestStreakDays, run);
      }
      for (let index = days.length - 1; index >= 0 && days[index].active; index -= 1) currentStreakDays += 1;
    }
    Object.assign(summary, {
      totalTokens: total('tokens'),
      maxSessionTokens: maximum('maxSessionTokens'),
      longestSessionMinutes: maximum('longestSessionMinutes'),
      currentStreakDays,
      longestStreakDays,
    });
  }
  if (surface) {
    Object.assign(summary, {
      newChats: total('newChats'),
      pluginCalls: total('pluginCalls'),
      browserCalls: total('browserCalls'),
      computerUseCalls: total('computerUseCalls'),
      otherToolCalls: total('otherToolCalls'),
      skillUses: total('skillUses'),
    });
    const sourceDays = snapshots.flatMap((snapshot) => snapshot.days.filter((day) => day.date >= from && day.date <= asOfDate));
    const modeKnown = sourceDays.length === 60 && sourceDays.every((day) => day.fastTurns !== null && day.modeTurns !== null);
    summary.fastModePercent = modeKnown ? percentage(sourceDays.reduce((sum, day) => sum + day.fastTurns, 0), sourceDays.reduce((sum, day) => sum + day.modeTurns, 0)) : null;
    const reasoningKnown = sourceDays.length === 60 && sourceDays.every((day) => day.reasoning !== null && day.reasoningTurns !== null);
    const reasoningTurns = reasoningKnown ? sourceDays.reduce((sum, day) => sum + day.reasoningTurns, 0) : 0;
    summary.reasoningPercent = reasoningKnown && reasoningTurns
      ? Object.fromEntries(REASONING_KEYS.map((key) => [key, percentage(sourceDays.reduce((sum, day) => sum + day.reasoning[key], 0), reasoningTurns)]))
      : null;
  }
  const unavailable = snapshots.length !== 2 || days.every((day) => day.active === null);
  const requiredSummary = surface ? ['activeDays', 'sessionDays', 'toolCalls', 'newChats', 'pluginCalls', 'browserCalls', 'computerUseCalls', 'otherToolCalls', 'totalTokens', 'maxSessionTokens', 'longestSessionMinutes', 'currentStreakDays', 'longestStreakDays'] : Object.keys(summary);
  const ready = !unavailable && fresh && days.every((day) => day.coverage === 'complete') && requiredSummary.every((key) => summary[key] !== null);
  return parsePublicActivity({
    schemaVersion: surface ? 3 : profile ? 2 : 1,
    metricScope: 'observed-local-codex',
    timezone: 'Asia/Seoul',
    window: { from, to: asOfDate },
    asOfDate,
    completeThroughDate,
    status: unavailable ? 'unavailable' : ready ? 'ready' : 'partial',
    ...(profile && { aggregation }),
    summary,
    days,
  });
}

export function aggregateCollections(collections, options) {
  const ids = ['public-collection-a', 'public-collection-b'];
  const collectedAt = new Date(options.referenceTime).toISOString();
  const snapshots = collections.map((collection, index) => ({
    sourceId: ids[index],
    snapshot: {
      schemaVersion: 3,
      revision: 1,
      policyId: 'local-codex-v1-kst-exclude-profile',
      collectedAt,
      timezone: collection.timezone,
      window: collection.window,
      days: collection.days,
    },
  }));
  return aggregateSnapshots(snapshots, { ...options, expectedSourceIds: ids, independentSources: true });
}
