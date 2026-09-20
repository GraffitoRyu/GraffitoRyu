import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parsePublicActivity } from './contract.mjs';

const SUMMARY_KEYS = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];

function count(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

export function sanitizeAccountUsageResponse(result, window) {
  if (!result || typeof result !== 'object' || !result.summary || !Array.isArray(result.dailyUsageBuckets)) throw new Error('account token usage unavailable');
  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, count(result.summary[key], key)]));
  const days = result.dailyUsageBuckets
    .filter((day) => day?.startDate >= window.from && day.startDate <= window.to)
    .map((day) => ({ date: day.startDate, tokens: count(day.tokens, 'daily tokens') }));
  return parsePublicActivity({ schemaVersion: 6, metricScope: 'codex-account-token-activity', timezone: 'Asia/Seoul', window, asOfDate: window.to, summary, days });
}

export function readAccountTokenUsage({ codexBinary, window, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('account token usage timed out')), timeoutMs);
    child.once('error', () => finish(new Error('account token usage failed')));
    child.once('exit', (code) => { if (!settled) finish(new Error(`account token usage exited ${code}`)); });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 7) return;
      if (message.error) return finish(new Error('account token usage rejected'));
      try { finish(null, sanitizeAccountUsageResponse(message.result, window)); }
      catch (error) { finish(error); }
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 0, params: { clientInfo: { name: 'profile_activity', title: 'Profile Activity', version: '1.0.0' } } })}\n${JSON.stringify({ method: 'initialized', params: {} })}\n${JSON.stringify({ method: 'account/usage/read', id: 7 })}\n`);
  });
}
