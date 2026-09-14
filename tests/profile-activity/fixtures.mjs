import { addDays } from '../../scripts/profile-activity/contract.mjs';

export const SOURCE_A = '11111111-1111-4111-8111-111111111111';
export const SOURCE_B = '22222222-2222-4222-8222-222222222222';

export function makeDays({ from = '2026-06-16', to = '2026-09-13', sessions = 0, calls = 0, coverage = 'complete' } = {}) {
  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    days.push({ date, active: coverage === 'unknown' ? null : sessions > 0 || calls > 0, activeSessions: coverage === 'unknown' ? null : sessions, toolCalls: coverage === 'unknown' ? null : calls, coverage });
  }
  return days;
}

export function makeSnapshot({ sourceId = SOURCE_A, revision = 1, sessions = 0, calls = 0, collectedAt = '2026-09-13T09:00:00.000Z', coverage = 'complete' } = {}) {
  return {
    schemaVersion: 1,
    sourceId,
    revision,
    policyId: 'local-codex-v1-kst-exclude-profile',
    collectedAt,
    timezone: 'Asia/Seoul',
    window: { from: '2026-06-16', to: '2026-09-13' },
    days: makeDays({ sessions, calls, coverage }),
  };
}

export function makePublicActivity({ unknown = false, calls = 0 } = {}) {
  const days = makeDays({ from: '2026-08-15', to: '2026-09-13', calls, coverage: unknown ? 'unknown' : 'complete' });
  return {
    schemaVersion: 1,
    metricScope: 'observed-local-codex',
    timezone: 'Asia/Seoul',
    window: { from: '2026-08-15', to: '2026-09-13' },
    asOfDate: '2026-09-13',
    completeThroughDate: unknown ? null : '2026-09-13',
    status: unknown ? 'unavailable' : 'ready',
    summary: { activeDays: unknown ? null : calls > 0 ? 30 : 0, sessionDays: unknown ? null : 0, toolCalls: unknown ? null : calls * 30 },
    days,
  };
}

export function rolloutLines({ id = 'session-a', cwd = '/work/project', events = [] } = {}) {
  return [
    { timestamp: '2026-09-12T00:00:00Z', type: 'session_meta', payload: { id, cwd } },
    ...events,
  ].map((value) => JSON.stringify(value)).join('\n') + '\n';
}

export function message(timestamp, extra = {}) {
  return { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: 'SYNTHETIC-CANARY', ...extra } };
}

export function call(timestamp, callId, extra = {}) {
  return { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'synthetic', arguments: 'PRIVATE-PATH-CANARY', call_id: callId, ...extra } };
}
