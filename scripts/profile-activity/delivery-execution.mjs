#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = new Set(['run']);
const MAX_BUFFER = 2 * 1024 * 1024;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`invalid ${name} keys`);
}

export function parseDeliveryCliOutput(command, text) {
  if (!COMMANDS.has(command) || typeof text !== 'string') throw new Error('invalid publication command');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.status !== 'string') throw new Error('invalid run result');
  if (value.status === 'published') {
    exactKeys(value, ['status', 'commit'], 'run result');
    if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) throw new Error('invalid publication commit');
    return value;
  }
  if (!['no-op', 'skipped-lock'].includes(value.status)) throw new Error('invalid run status');
  exactKeys(value, ['status'], 'run result');
  return value;
}

export function failureEvidence({ stage, error, stateChanged = 'unknown', exitCode = error?.status ?? null, signal = error?.signal ?? null }) {
  const permission = ['EACCES', 'EPERM'].includes(error?.code);
  const validation = !permission && /invalid|usage|mismatch|conflict|rollback|schema|digest|source|required|refused/i.test(error?.message ?? '');
  const integrity = !permission && !validation && /runtime|manifest|receipt|repository|remote|hook|allowlist/i.test(error?.message ?? '');
  const errorClass = permission ? 'permission' : validation ? 'validation' : integrity ? 'integrity' : 'execution';
  const stderrClass = permission ? 'permission-denied' : validation ? 'validation-rejected' : integrity ? 'integrity-rejected' : 'execution-failed';
  return { status: 'error', stage, exitCode: Number.isSafeInteger(exitCode) ? exitCode : null, signal: typeof signal === 'string' ? signal : null, errorClass, stderrClass, stateChanged };
}

function parseFailureEvidence(text, stage) {
  const value = JSON.parse(String(text));
  exactKeys(value, ['status', 'stage', 'exitCode', 'signal', 'errorClass', 'stderrClass', 'stateChanged'], 'failure evidence');
  if (value.status !== 'error' || value.stage !== stage || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 1)) || (value.signal !== null && typeof value.signal !== 'string')) throw new Error('invalid failure evidence');
  if (!['permission', 'validation', 'integrity', 'execution'].includes(value.errorClass)) throw new Error('invalid error class');
  if (!['permission-denied', 'validation-rejected', 'integrity-rejected', 'execution-failed'].includes(value.stderrClass)) throw new Error('invalid stderr class');
  if (typeof value.stateChanged !== 'boolean' && value.stateChanged !== 'unknown') throw new Error('invalid state change evidence');
  return value;
}

function installedPaths(receiptFile) {
  if (typeof receiptFile !== 'string') throw new Error('invalid receipt');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (typeof receipt.nodeBinary !== 'string' || !path.isAbsolute(receipt.nodeBinary) || typeof receipt.runtimeDir !== 'string' || !path.isAbsolute(receipt.runtimeDir) || typeof receipt.stateDir !== 'string' || !path.isAbsolute(receipt.stateDir)) throw new Error('invalid receipt');
  if (realpathSync(receiptFile) !== path.join(realpathSync(receipt.stateDir), 'installation-receipt.json')) throw new Error('invalid receipt path');
  return { nodeBinary: receipt.nodeBinary, cli: path.join(receipt.runtimeDir, 'cli.mjs'), config: path.join(receipt.stateDir, 'installed-config.json') };
}

function invoke(paths, command, input) {
  try {
    const stdout = execFileSync(paths.nodeBinary, [paths.cli, command, '--config', paths.config, ...(command === 'run' && input !== undefined ? ['--account-usage-stdin'] : [])], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER,
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    });
    return parseDeliveryCliOutput(command, stdout);
  } catch (error) {
    const failure = new Error(`delivery ${command} failed`);
    try { failure.evidence = parseFailureEvidence(error.stderr, command); }
    catch { failure.evidence = failureEvidence({ stage: command, error, stateChanged: 'unknown' }); }
    throw failure;
  }
}

export function createInstalledCliInvocation(options) {
  if (!options || Object.keys(options).some((key) => !['receiptFile', 'command', 'input'].includes(key))) throw new Error('invalid invocation keys');
  const { receiptFile, command, input } = options;
  if (!COMMANDS.has(command)) throw new Error('invalid invocation');
  const paths = installedPaths(receiptFile);
  let started = false;
  return {
    run() {
      if (started) throw new Error('invocation already started');
      started = true;
      return invoke(paths, command, input);
    },
  };
}

function main() {
  const [command, flag, receiptFile, ...extra] = process.argv.slice(2);
  if (!COMMANDS.has(command) || flag !== '--receipt' || !receiptFile || extra.length) throw new Error('usage');
  const inputText = readFileSync(0, 'utf8').trim();
  const input = inputText ? JSON.parse(inputText) : undefined;
  process.stdout.write(`${JSON.stringify(createInstalledCliInvocation({ receiptFile, command, input }).run())}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify(error.evidence ?? failureEvidence({ stage: process.argv[2] ?? 'startup', error, stateChanged: 'unknown', exitCode: 1 }))}\n`);
    process.exitCode = 1;
  }
}
