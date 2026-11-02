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

// T3 Code installs agy as an ACP (Agent Client Protocol) server rather than the `agy` CLI:
//   <T3CODE_HOME>/tools/antigravity-acp/<platform>-<arch>/active.json -> versions/<releaseId>/agy_acp_server.par
// with one Gemini home per T3 provider instance holding its login:
//   <T3CODE_HOME>/userdata/providers/antigravity/<instance>/antigravity-acp/acp_token.json
// It has no print mode, but its `/usage` slash command is answered by the server itself, without a model
// turn or token cost, as Markdown built from the same quota groups/buckets as the CLI's JSON report.
const T3_LOGINS = ['acp_token.json', 'acp_business_token.json'];

export function findT3Antigravity({ home, environment }) {
  const t3 = environment.T3CODE_HOME || path.join(home, '.t3');
  if (!path.isAbsolute(t3)) return null;
  let runtime;
  try {
    const tools = path.join(t3, 'tools/antigravity-acp', `${process.platform}-${process.arch}`);
    const { releaseId } = JSON.parse(fs.readFileSync(path.join(tools, 'active.json'), 'utf8'));
    if (typeof releaseId !== 'string' || !/^[\w.-]+$/.test(releaseId) || /^\.+$/.test(releaseId)) return null;
    const dir = path.join(tools, 'versions', releaseId);
    runtime = { server: path.join(dir, 'agy_acp_server.par'), harness: path.join(dir, 'localharness_external'), geminiHome: null };
    for (const file of [runtime.server, runtime.harness]) {
      fs.accessSync(file, fs.constants.X_OK);
      if (!fs.statSync(file).isFile()) return null;
    }
  } catch {
    return null;
  }
  // Use the most recently signed-in provider instance.
  let latest = -Infinity;
  const providers = path.join(t3, 'userdata/providers/antigravity');
  let instances = [];
  try { instances = fs.readdirSync(providers); } catch {}
  for (const instance of instances) {
    for (const login of T3_LOGINS) {
      try {
        const stat = fs.statSync(path.join(providers, instance, 'antigravity-acp', login));
        if (stat.isFile() && stat.mtimeMs > latest) [latest, runtime.geminiHome] = [stat.mtimeMs, path.join(providers, instance)];
      } catch {}
    }
  }
  return runtime;
}

// Speaks just enough ACP (newline-delimited JSON-RPC 2.0 over stdio) to open a session and send `/usage`,
// resolving with the reply's Markdown. Requests from the server (permissions, files, terminals) are refused.
// Same process-group, deadline and output-limit handling as runAntigravity.
export function runAntigravityAcp(server, { cwd, env, timeoutMs, maxBytes = 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    // `--uid=` stops the server switching to the `nobody` user at startup, as T3 Code launches it.
    const child = spawn(server, ['--uid='], { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', size = 0, text = '', sessionId = null, done = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const finish = (failure, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('exit', kill);
      kill();
      if (failure) reject(failure); else resolve(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    process.once('exit', kill);
    const timer = setTimeout(() => finish(error('TIMEOUT')), timeoutMs);
    const replies = {
      1: () => send({ id: 2, method: 'session/new', params: { cwd, mcpServers: [] } }),
      2: (result) => {
        sessionId = result?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) return finish(error('REPORT'));
        send({ id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/usage' }] } });
      },
      3: (result) => finish(result?.stopReason === 'end_turn' && text ? null : error('REPORT'), text),
    };
    const handle = (message) => {
      if (message?.method !== undefined) {
        const update = message.params?.update;
        if (message.method === 'session/update' && sessionId && message.params?.sessionId === sessionId
          && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
          text += update.content.text;
        } else if (message.id !== undefined && message.id !== null) {
          send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        }
        return;
      }
      const reply = replies[message?.id];
      if (!reply) return;
      // -32000 is ACP's "authentication required".
      if (message.error) return finish(error(message.error.code === -32000 ? 'AUTH' : 'EXIT'));
      reply(message.result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) return finish(error('OUTPUT'));
      buffer += chunk;
      for (let end; !done && (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(error('REPORT')); }
        handle(message);
      }
    });
    // Diagnostics only decide between sign-in and other failures; just a bounded tail is kept.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(error('LAUNCH')));
    child.once('exit', kill);
    child.once('close', () => finish(error(/sign.?in|log.?in|authenticat|oauth/i.test(stderr) ? 'AUTH' : 'EXIT')));
    send({ id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-quota-dashboard', version: '0.1.0' },
    } });
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Turns the ACP server's `/usage` Markdown into the CLI's report shape for antigravityWindows. Its
// "### Quota Limits" section lists `- **<group>**` lines, each followed by `  - **<bucket>:** <status>` lines
// where status is "<n>% remaining", "<n> units remaining", "Available" or "Disabled[: why]", optionally
// suffixed with " (resets Nov 03, 2026, 14:20 UTC)". Percentages are whole numbers.
export function parseAcpUsage(markdown) {
  const section = typeof markdown === 'string' ? markdown.split(/^### Quota Limits[ \t]*$/m)[1] : undefined;
  if (section === undefined) throw error('REPORT');
  const groups = [];
  for (const line of section.split(/\r?\n/)) {
    if (/^#/.test(line)) break;
    if (/^- Unable to retrieve quota status\b/.test(line)) throw error('QUOTA');
    if (/^- Not applicable for current authentication method/.test(line)) throw error('METHOD');
    if (/^- data not available yet/.test(line)) throw error('AUTH');
    let match = /^- \*\*(.+)\*\*\s*$/.exec(line);
    if (match) { groups.push({ name: match[1].trim(), buckets: [] }); continue; }
    match = /^\s+- \*\*(.+?):\*\* (.*)$/.exec(line);
    if (!match) continue;
    if (!groups.length) throw error('REPORT');
    const name = match[1].trim(), status = match[2];
    const reset = /\s*\(resets (.+)\)$/.exec(status);
    const body = (reset ? status.slice(0, reset.index) : status).trim();
    const percent = /^(\d{1,3})% remaining$/.exec(body);
    const when = reset && /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) UTC$/.exec(reset[1].trim());
    let resetTime = reset ? reset[1].trim() : undefined;
    if (when && MONTHS.includes(when[1])) {
      resetTime = new Date(Date.UTC(+when[3], MONTHS.indexOf(when[1]), +when[2], +when[4], +when[5])).toISOString();
    }
    groups.at(-1).buckets.push({
      id: name, name,
      window: /\bweekly\b/i.test(name) ? 'weekly' : /\b(five[\s-]hour|5[\s-]?h(ou)?r?)\b/i.test(name) ? '5h' : undefined,
      remaining_fraction: percent ? Number(percent[1]) / 100 : undefined,
      disabled: /^Disabled\b/.test(body), reset_time: resetTime,
    });
  }
  return { status: 'SUCCESS', command: { name: 'usage', data: { groups } } };
}

const ERRORS = {
  MISSING: 'Antigravity CLI not found. Install `agy` and sign in, sign in to Antigravity in T3 Code, or set `ANTIGRAVITY_CLI_PATH` to its absolute path.',
  VERSION: 'Quota reports require `agy` 1.1.11 or later. Update the CLI and refresh.',
  AUTH: 'Antigravity needs sign-in. Run `agy` in a terminal and sign in, then refresh.',
  TIMEOUT: 'Antigravity usage check timed out. Run `agy` in a terminal to check sign-in, then refresh.',
  OUTPUT: 'Antigravity returned too much output; usage is unavailable.',
  REPORT: 'Antigravity returned no valid quota report. Check `/usage` in `agy` and refresh.',
  FAILED: 'Antigravity usage check failed. Check `/usage` in `agy` and refresh.',
};
const T3_ERRORS = {
  ...ERRORS,
  AUTH: 'Antigravity needs sign-in. Sign in to Antigravity in T3 Code, then refresh.',
  TIMEOUT: 'Antigravity usage check timed out. Check that Antigravity works in T3 Code, then refresh.',
  REPORT: 'Antigravity returned no valid quota report. Check `/usage` in a T3 Code Antigravity thread and refresh.',
  QUOTA: 'Antigravity could not retrieve quota status. Check `/usage` in a T3 Code Antigravity thread and refresh.',
  METHOD: 'Antigravity reports quota limits only for Google account sign-ins, not API keys or Vertex AI.',
  FAILED: 'Antigravity usage check failed. Check `/usage` in a T3 Code Antigravity thread and refresh.',
};

// A private temporary directory whose `open`/`xdg-open` fail, so a background check can never open a
// browser or wait for a desktop login prompt.
function sandbox(home, environment) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-agy-'));
  for (const command of ['open', 'xdg-open']) fs.writeFileSync(path.join(directory, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const env = {
    ...environment, HOME: home, PWD: directory,
    PATH: `${directory}${path.delimiter}${environment.PATH || '/usr/bin:/bin'}`,
    BROWSER: path.join(directory, 'open'), DISPLAY: '', WAYLAND_DISPLAY: '',
  };
  return { directory, env };
}

export async function fetchAntigravity({ home, environment, run = runAntigravity, runAcp = runAntigravityAcp, previouslySeen = false }) {
  const base = { id: ANTIGRAVITY_ID, provider: 'antigravity', name: 'Antigravity', email: null, plan: null };
  const binary = findAntigravity({ home, environment });
  // The standalone CLI wins; T3 Code's runtime is the fallback unless ANTIGRAVITY_CLI_PATH pins the CLI.
  const t3 = !binary && environment.ANTIGRAVITY_CLI_PATH === undefined ? findT3Antigravity({ home, environment }) : null;
  if (t3) return fetchT3Antigravity({ ...base, sources: ['T3 Code agy runtime'] }, t3, { home, environment, runAcp, previouslySeen });
  if (!binary && environment.ANTIGRAVITY_CLI_PATH === undefined && !previouslySeen) return [];
  const account = { ...base, sources: ['agy CLI'] };
  let directory;
  try {
    if (!binary) throw error('MISSING');
    const box = sandbox(home, environment);
    directory = box.directory;
    const env = { ...box.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    const version = (await run(binary, ['--version'], { cwd: directory, env, timeoutMs: 5000 })).trim();
    const parts = /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : [];
    if (!(parts[0] > 1 || (parts[0] === 1 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 11))))) throw error('VERSION');
    const output = await run(binary, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'], { cwd: directory, env, timeoutMs: 90_000 });
    let report;
    try { report = JSON.parse(output); } catch { throw error('REPORT'); }
    const windows = antigravityWindows(report);
    return [{ ...account, windows, limitReached: windows.some((w) => w.usedPct === 100) }];
  } catch (err) {
    // Never put stdout, stderr, OAuth URLs, credentials or local paths in the API/cache.
    return [{ ...account, error: ERRORS[err.code] || ERRORS.FAILED }];
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The server runs against a throwaway Gemini home so its session, trajectory and harness files never land
// in T3 Code's state. The login files are symlinked, not copied: the server reads them in place, and since it
// saves credentials with an atomic replace (and signs out by unlinking), any refresh or sign-out it does only
// swaps the link in the temporary home. T3 Code's own files are never written.
async function fetchT3Antigravity(account, runtime, { home, environment, runAcp, previouslySeen }) {
  if (!runtime.geminiHome) return previouslySeen ? [{ ...account, error: T3_ERRORS.AUTH }] : [];
  let directory;
  try {
    const box = sandbox(home, environment);
    directory = box.directory;
    const geminiHome = path.join(directory, 'gemini');
    const state = path.join(geminiHome, 'antigravity-acp');
    const work = path.join(directory, 'work');
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    fs.mkdirSync(work, { mode: 0o700 });
    const source = path.join(runtime.geminiHome, 'antigravity-acp');
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isFile()) fs.symlinkSync(path.join(source, entry.name), path.join(state, entry.name));
    }
    const env = {
      ...box.env, PWD: work, GEMINI_HOME: geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1',
      ANTIGRAVITY_HARNESS_PATH: runtime.harness, AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    };
    const markdown = await runAcp(runtime.server, { cwd: work, env, timeoutMs: 90_000 });
    const windows = antigravityWindows(parseAcpUsage(markdown));
    return [{ ...account, windows, limitReached: windows.some((w) => w.usedPct === 100) }];
  } catch (err) {
    // Never put protocol output, diagnostics, OAuth URLs, credentials or local paths in the API/cache.
    return [{ ...account, error: T3_ERRORS[err.code] || T3_ERRORS.FAILED }];
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
