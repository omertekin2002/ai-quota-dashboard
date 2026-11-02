// agy >= 1.1.11 answers /usage in print mode without starting a model turn.
// Wire format reference (synthetic reports):
// https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/AntigravityCLIUsageReportTests.swift
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ANTIGRAVITY_ID = 'antigravity:local';
const text = (v) => typeof v === 'string' ? v.trim() : '';
const error = (code) => Object.assign(new Error(code), { code });

export function antigravityWindows(report) {
  if (report?.status !== 'SUCCESS' || report.command?.name !== 'usage') throw error('REPORT');
  const groups = report.command.data?.groups;
  if (!Array.isArray(groups)) throw error('REPORT');
  const windows = [];
  const seen = new Set();
  for (const group of groups) {
    const family = text(group?.name ?? group?.display_name ?? group?.displayName);
    if (!family || !Array.isArray(group.buckets)) throw error('REPORT');
    for (const bucket of group.buckets) {
      const id = text(bucket?.id ?? bucket?.bucket_id ?? bucket?.bucketId);
      if (!id) throw error('REPORT');
      const key = JSON.stringify([family, id]);
      if (seen.has(key)) throw error('REPORT');
      seen.add(key);
      const cadence = text(bucket.window);
      const windowSec = cadence === '5h' ? 18000 : cadence === 'weekly' ? 604800 : null;
      const label = (cadence === '5h' ? '5-hour' : cadence === 'weekly' ? 'Weekly' : null)
        ?? (text(bucket.name ?? bucket.display_name ?? bucket.displayName) || id);
      const remaining = bucket.remaining_fraction ?? bucket.remainingFraction
        ?? bucket.remaining?.remaining_fraction ?? bucket.remaining?.remainingFraction
        ?? (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : undefined);
      const disabled = bucket.disabled === true;
      const known = !disabled && typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1;
      const reset = Date.parse(text(bucket.reset_time ?? bucket.resetTime));
      windows.push({
        id: key, label: `${family} · ${label}`,
        usedPct: known ? Math.round((1 - remaining) * 1e8) / 1e6 : null,
        resetsAt: Number.isFinite(reset) ? reset : null, windowSec, disabled,
        // Don't invent billing cycles or assume that a past reset refilled an unknown bucket.
        estimateReset: false, resetLabel: 'Reset time unavailable',
      });
    }
  }
  if (!windows.length) throw error('REPORT');
  return windows;
}

export function findAntigravity({ home, environment }) {
  const explicit = environment.ANTIGRAVITY_CLI_PATH;
  const candidates = explicit !== undefined ? [explicit] : [
    ...(environment.PATH || '').split(path.delimiter).filter((p) => path.isAbsolute(p)).map((p) => path.join(p, 'agy')),
    path.join(home, '.local/bin/agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy',
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Own a process group, so timeouts, excessive output and normal exits also clean up the
// CLI's language-server children. Never touch another agy session. No shell or open stdin.
export function runAntigravity(binary, args, { cwd, env, timeoutMs, maxBytes = 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure = null;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const stop = (code) => { failure ||= error(code); kill(); };
    // The dashboard may exit during a pending collection (e.g. a service restart).
    process.once('exit', kill);
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) { stop('OUTPUT'); return; }
        if (isOut) stdout += chunk; else stderr += chunk;
      });
    }
    child.once('error', () => { failure ||= error('LAUNCH'); });
    child.once('exit', kill);
    child.once('close', (code) => {
      clearTimeout(timer);
      process.removeListener('exit', kill);
      kill();
      if (failure) reject(failure);
      else if (code !== 0) {
        const auth = /sign.?in|log.?in|authentication|oauth|keyring/i.test(stderr + stdout);
        reject(error(auth ? 'AUTH' : 'EXIT'));
      } else resolve(stdout);
    });
  });
}

const ERRORS = {
  MISSING: 'Antigravity CLI not found. Install `agy` and sign in, or set `ANTIGRAVITY_CLI_PATH` to its absolute path.',
  VERSION: 'Quota reports require `agy` 1.1.11 or later. Update the CLI and refresh.',
  AUTH: 'Antigravity needs sign-in. Run `agy` in a terminal and sign in, then refresh.',
  TIMEOUT: 'Antigravity usage check timed out. Run `agy` in a terminal to check sign-in, then refresh.',
  OUTPUT: 'Antigravity returned too much output; usage is unavailable.',
  REPORT: 'Antigravity returned no valid quota report. Check `/usage` in `agy` and refresh.',
};

export async function fetchAntigravity({ home, environment, run = runAntigravity, previouslySeen = false }) {
  const base = { id: ANTIGRAVITY_ID, provider: 'antigravity', name: 'Antigravity', email: null, plan: null, sources: ['agy CLI'] };
  const binary = findAntigravity({ home, environment });
  if (!binary && environment.ANTIGRAVITY_CLI_PATH === undefined && !previouslySeen) return [];
  let directory;
  try {
    if (!binary) throw error('MISSING');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-agy-'));
    // A background check must never open a browser or wait for a desktop login prompt.
    for (const command of ['open', 'xdg-open']) fs.writeFileSync(path.join(directory, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const env = {
      ...environment, HOME: home, PWD: directory,
      PATH: `${directory}${path.delimiter}${environment.PATH || '/usr/bin:/bin'}`,
      BROWSER: path.join(directory, 'open'), DISPLAY: '', WAYLAND_DISPLAY: '',
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    };
    const version = (await run(binary, ['--version'], { cwd: directory, env, timeoutMs: 5000 })).trim();
    const parts = /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : [];
    if (!(parts[0] > 1 || (parts[0] === 1 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 11))))) throw error('VERSION');
    const output = await run(binary, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'], { cwd: directory, env, timeoutMs: 90_000 });
    let report;
    try { report = JSON.parse(output); } catch { throw error('REPORT'); }
    const windows = antigravityWindows(report);
    return [{ ...base, windows, limitReached: windows.some((w) => w.usedPct === 100) }];
  } catch (err) {
    // Never put stdout, stderr, OAuth URLs, credentials or local paths in the API/cache.
    return [{ ...base, error: ERRORS[err.code] || 'Antigravity usage check failed. Check `/usage` in `agy` and refresh.' }];
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
