#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`invalid ${name} keys`);
}

export function parseRunOutput(text) {
  const value = JSON.parse(text);
  if (value?.status === 'published') {
    exactKeys(value, ['status', 'commit'], 'run result');
    if (!/^[0-9a-f]{40}$/.test(value.commit)) throw new Error('invalid publication commit');
    return value;
  }
  if (!['no-op', 'skipped-lock'].includes(value?.status)) throw new Error('invalid run status');
  exactKeys(value, ['status'], 'run result');
  return value;
}

export function failureEvidence({ stage, error, stateChanged = 'unknown', exitCode = error?.status ?? null, signal = error?.signal ?? null }) {
  const permission = ['EACCES', 'EPERM'].includes(error?.code);
  const validation = !permission && /invalid|usage|mismatch|conflict|schema|required|refused|unavailable/i.test(error?.message ?? '');
  const integrity = !permission && !validation && /runtime|manifest|receipt|repository|remote|hook|allowlist/i.test(error?.message ?? '');
  const errorClass = permission ? 'permission' : validation ? 'validation' : integrity ? 'integrity' : 'execution';
  const stderrClass = permission ? 'permission-denied' : validation ? 'validation-rejected' : integrity ? 'integrity-rejected' : 'execution-failed';
  return { status: 'error', stage, exitCode: Number.isSafeInteger(exitCode) ? exitCode : null, signal: typeof signal === 'string' ? signal : null, errorClass, stderrClass, stateChanged };
}

function installedPaths(receiptFile) {
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (receipt.schemaVersion !== 2 || typeof receipt.nodeBinary !== 'string' || !path.isAbsolute(receipt.nodeBinary) || typeof receipt.runtimeDir !== 'string' || !path.isAbsolute(receipt.runtimeDir) || typeof receipt.stateDir !== 'string' || !path.isAbsolute(receipt.stateDir)) throw new Error('invalid receipt');
  if (realpathSync(receiptFile) !== path.join(realpathSync(receipt.stateDir), 'installation-receipt.json')) throw new Error('invalid receipt path');
  return { nodeBinary: receipt.nodeBinary, cli: path.join(receipt.runtimeDir, 'cli.mjs'), config: path.join(receipt.stateDir, 'installed-config.json') };
}

export function runInstalled(receiptFile) {
  const paths = installedPaths(receiptFile);
  try {
    return parseRunOutput(execFileSync(paths.nodeBinary, [paths.cli, 'run', '--config', paths.config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) {
    const failure = new Error('profile activity run failed');
    failure.evidence = failureEvidence({ stage: 'run', error, stateChanged: 'unknown' });
    throw failure;
  }
}

function main() {
  const [command, flag, receiptFile, ...extra] = process.argv.slice(2);
  if (command !== 'run' || flag !== '--receipt' || !receiptFile || extra.length) throw new Error('usage');
  process.stdout.write(`${JSON.stringify(runInstalled(receiptFile))}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify(error.evidence ?? failureEvidence({ stage: 'run', error, stateChanged: 'unknown', exitCode: 1 }))}\n`);
    process.exitCode = 1;
  }
}
