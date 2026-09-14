import { addDays, parseDate, parsePublicActivity } from './contract.mjs';
import { chooseLatestSnapshots } from './snapshot.mjs';

export function aggregateSnapshots(inputs, options) {
  const asOfDate = parseDate(options.asOfDate, 'asOfDate');
  if (!Array.isArray(options.expectedSourceIds) || options.expectedSourceIds.length !== 2 || new Set(options.expectedSourceIds).size !== 2) throw new Error('exactly two sources required');
  const referenceTime = new Date(options.referenceTime);
  if (Number.isNaN(referenceTime.valueOf())) throw new Error('invalid referenceTime');
  const snapshots = chooseLatestSnapshots(inputs, options.expectedSourceIds);
  if (snapshots.some((snapshot) => new Date(snapshot.collectedAt) - referenceTime > 5 * 60 * 1000)) throw new Error('snapshot is too far in the future');
  const from = addDays(asOfDate, -29);
  const bySource = new Map(snapshots.map((snapshot) => [snapshot.sourceId, new Map(snapshot.days.map((day) => [day.date, day]))]));
  const days = [];
  for (let date = from; date <= asOfDate; date = addDays(date, 1)) {
    const sourceDays = options.expectedSourceIds.map((id) => bySource.get(id)?.get(date));
    const allKnown = sourceDays.every((day) => day && day.coverage !== 'unknown');
    const anyActive = sourceDays.some((day) => day?.active === true);
    const allInactive = sourceDays.every((day) => day?.active === false);
    const active = anyActive ? true : allInactive ? false : null;
    const countsKnown = allKnown && options.independentSources === true && sourceDays.every((day) => day.activeSessions !== null && day.toolCalls !== null);
    const coverage = sourceDays.every((day) => day?.coverage === 'complete') ? 'complete' : sourceDays.some((day) => day && day.coverage !== 'unknown') ? 'partial' : 'unknown';
    days.push({
      date,
      active,
      activeSessions: countsKnown ? sourceDays.reduce((sum, day) => sum + day.activeSessions, 0) : null,
      toolCalls: countsKnown ? sourceDays.reduce((sum, day) => sum + day.toolCalls, 0) : null,
      coverage,
    });
  }
  const fresh = snapshots.length === 2 && snapshots.every((snapshot) => referenceTime - new Date(snapshot.collectedAt) <= (options.staleAfterHours ?? 36) * 3600000);
  let completeThroughDate = null;
  for (const day of days) {
    if (day.coverage !== 'complete') break;
    completeThroughDate = day.date;
  }
  const every = (key) => days.every((day) => day[key] !== null);
  const summary = {
    activeDays: every('active') ? days.filter((day) => day.active).length : null,
    sessionDays: every('activeSessions') ? days.reduce((sum, day) => sum + day.activeSessions, 0) : null,
    toolCalls: every('toolCalls') ? days.reduce((sum, day) => sum + day.toolCalls, 0) : null,
  };
  const unavailable = snapshots.length !== 2 || days.every((day) => day.active === null);
  const ready = !unavailable && fresh && days.every((day) => day.coverage === 'complete') && Object.values(summary).every((value) => value !== null);
  return parsePublicActivity({
    schemaVersion: 1,
    metricScope: 'observed-local-codex',
    timezone: 'Asia/Seoul',
    window: { from, to: asOfDate },
    asOfDate,
    completeThroughDate,
    status: unavailable ? 'unavailable' : ready ? 'ready' : 'partial',
    summary,
    days,
  });
}
