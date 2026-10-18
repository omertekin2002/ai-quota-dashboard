#!/usr/bin/env node
// AI quota dashboard: remaining 5-hour / weekly limits for Claude and ChatGPT (Codex) subscriptions.
//
//   node server.mjs          serve the dashboard on http://localhost:7417
//   node server.mjs --json   print current quotas as JSON and exit
//
// Credentials are read from wherever the CLIs already keep them: the Claude Code Keychain item,
// ~/.codex/auth.json, and CLIProxyAPI's auth dir (~/.cli-proxy-api, used by VibeProxy). Nothing is
// refreshed or written back: those refresh tokens rotate, so refreshing here would log the CLIs out.
// Tokens are only ever sent to api.anthropic.com and chatgpt.com.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 7417);
const AUTH_DIR = expand(process.env.CLIPROXY_AUTH_DIR || '~/.cli-proxy-api');
const CODEX_HOME = expand(process.env.CODEX_HOME || '~/.codex');
// Extra Host names to answer to, e.g. the MagicDNS name when published with `tailscale serve`.
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  ...(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean),
]);
const TTL_MS = 90_000; // normal polling: at most one upstream round per 90s
const FORCE_MIN_MS = 15_000; // manual refresh: at most one per 15s
const PROFILE_TTL_MS = 15 * 60_000; // plan lookup: re-checked this often, and on every manual refresh
const LAST_GOOD_FILE = path.join(HERE, '.cache', 'last-good.json');

function expand(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// ---------- credential discovery ----------

function proxyAuthFiles(type) {
  let names;
  try {
    names = fs.readdirSync(AUTH_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(AUTH_DIR, n)))
    .filter((d) => d && d.type === type && !d.disabled && d.access_token);
}

function claudeCredentials() {
  const creds = [];
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const o = JSON.parse(raw).claudeAiOauth;
      if (o?.accessToken) creds.push({ token: o.accessToken, expiresAt: toMs(o.expiresAt), plan: o.subscriptionType, source: 'Claude Code' });
    } catch {}
  }
  const file = readJson(path.join(HOME, '.claude', '.credentials.json'))?.claudeAiOauth;
  if (file?.accessToken) creds.push({ token: file.accessToken, expiresAt: toMs(file.expiresAt), plan: file.subscriptionType, source: 'Claude Code' });
  for (const f of proxyAuthFiles('claude')) {
    creds.push({ token: f.access_token, expiresAt: toMs(f.expired), email: f.email, source: 'CLIProxyAPI' });
  }
  return creds;
}

function codexCredential(token, accountId, idToken, source) {
  const claims = jwtClaims(token);
  const id = jwtClaims(idToken || '');
  return {
    token,
    accountId: accountId || claims['https://api.openai.com/auth']?.chatgpt_account_id,
    expiresAt: toMs(claims.exp),
    email: id.email || claims['https://api.openai.com/profile']?.email,
    source,
  };
}

function codexCredentials() {
  const creds = [];
  const auth = readJson(path.join(CODEX_HOME, 'auth.json'));
  if (auth?.tokens?.access_token) {
    creds.push(codexCredential(auth.tokens.access_token, auth.tokens.account_id, auth.tokens.id_token, 'Codex CLI'));
  }
  for (const f of proxyAuthFiles('codex')) creds.push(codexCredential(f.access_token, f.account_id, f.id_token, 'CLIProxyAPI'));
  return creds;
}

// Several sources often hold the same account. Group them, newest token first.
function groupBy(creds, keyOf) {
  const groups = new Map();
  for (const c of creds) {
    const key = keyOf(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const list of groups.values()) list.sort((a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity));
  return groups;
}

// Try each credential of an account until one works; skip ones that are already expired.
async function withFirstWorking(list, fn) {
  let lastErr;
  for (const cred of list) {
    if (cred.expiresAt && cred.expiresAt < Date.now()) {
      lastErr = Object.assign(new Error('token expired'), { status: 401 });
      continue;
    }
    try {
      return await fn(cred);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------- Claude ----------

const claudeHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-code/2.1.302',
  Accept: 'application/json',
});

const profileCache = new Map();
async function claudeProfile(cred, force) {
  const key = hash(cred.token);
  const hit = profileCache.get(key);
  if (hit && !force && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const profile = await getJson('https://api.anthropic.com/api/oauth/profile', claudeHeaders(cred.token)).catch(() => null);
  if (profile) profileCache.set(key, { at: Date.now(), profile });
  // A failed re-check keeps the last answer instead of dropping to the plan saved at login.
  return profile ?? hit?.profile ?? null;
}

function claudePlan(profile, fallback) {
  const org = profile?.organization || {};
  const tier = org.rate_limit_tier || '';
  if (profile?.account?.has_claude_max || tier.includes('max')) {
    const mult = tier.match(/(\d+)x/);
    return mult ? `Max ${mult[1]}x` : 'Max';
  }
  if (org.organization_type) return titleCase(org.organization_type.replace(/^claude_/, '').replace(/_/g, ' '));
  return titleCase(fallback) || null;
}

function claudeWindows(u) {
  const defs = [
    ['five_hour', '5-hour', 5 * 3600],
    ['seven_day', 'Weekly', 7 * 86400],
    ['seven_day_opus', 'Weekly · Opus', 7 * 86400],
    ['seven_day_sonnet', 'Weekly · Sonnet', 7 * 86400],
  ];
  const windows = defs
    .filter(([key]) => u[key])
    .map(([key, label, windowSec]) => ({
      id: key,
      label,
      usedPct: u[key].utilization ?? 0,
      resetsAt: toMs(u[key].resets_at),
      windowSec,
    }));
  if (u.extra_usage?.is_enabled && typeof u.extra_usage.utilization === 'number') {
    windows.push({ id: 'extra_usage', label: 'Extra usage · monthly', usedPct: u.extra_usage.utilization, resetsAt: null, windowSec: null });
  }
  return windows;
}

async function fetchClaude(force) {
  const creds = claudeCredentials();
  // Identify each token's account (email) so the same login from two sources shows once.
  for (const c of creds) {
    const p = await claudeProfile(c, force);
    c.profile = p;
    c.email = p?.account?.email || c.email;
  }
  const groups = groupBy(creds, (c) => c.email || hash(c.token));
  const accounts = [];
  for (const [key, list] of groups) {
    const base = {
      id: `claude:${key}`,
      provider: 'claude',
      name: 'Claude',
      email: list[0].email || null,
      plan: claudePlan(list.find((c) => c.profile)?.profile, list[0].plan),
      sources: [...new Set(list.map((c) => c.source))],
    };
    try {
      const usage = await withFirstWorking(list, (c) => getJson('https://api.anthropic.com/api/oauth/usage', claudeHeaders(c.token)));
      const windows = claudeWindows(usage);
      accounts.push({ ...base, windows, limitReached: windows.some((w) => w.usedPct >= 100) });
    } catch (err) {
      accounts.push({ ...base, error: describeError(err, 'claude') });
    }
  }
  return accounts;
}

// ---------- OpenAI / Codex ----------

function windowLabel(sec) {
  if (!sec) return null;
  if (sec === 5 * 3600) return '5-hour';
  if (sec === 7 * 86400) return 'Weekly';
  if (sec >= 28 * 86400 && sec <= 31 * 86400) return 'Monthly';
  if (sec % 86400 === 0) return `${sec / 86400}-day`;
  if (sec % 3600 === 0) return `${sec / 3600}-hour`;
  return `${Math.round(sec / 60)}-min`;
}

function codexWindows(u) {
  const windows = [];
  const add = (w, prefix, id) => {
    if (!w) return;
    windows.push({
      id,
      label: [prefix, windowLabel(w.limit_window_seconds)].filter(Boolean).join(' · '),
      usedPct: w.used_percent ?? 0,
      resetsAt: toMs(w.reset_at) ?? (w.reset_after_seconds != null ? Date.now() + w.reset_after_seconds * 1000 : null),
      windowSec: w.limit_window_seconds ?? null,
    });
  };
  add(u.rate_limit?.primary_window, '', 'primary');
  add(u.rate_limit?.secondary_window, '', 'secondary');
  (u.additional_rate_limits || []).forEach((r, i) => {
    const name = r.limit_name || r.metered_feature || `Limit ${i + 1}`;
    add(r.rate_limit?.primary_window, name, `extra-${i}-primary`);
    add(r.rate_limit?.secondary_window, name, `extra-${i}-secondary`);
  });
  const cr = u.code_review_rate_limit;
  add(cr?.primary_window ?? cr?.rate_limit?.primary_window, 'Code review', 'code-review-primary');
  add(cr?.secondary_window ?? cr?.rate_limit?.secondary_window, 'Code review', 'code-review-secondary');
  return windows;
}

async function fetchCodex() {
  const groups = groupBy(codexCredentials(), (c) => c.accountId || hash(c.token));
  const accounts = [];
  for (const [key, list] of groups) {
    const base = {
      id: `openai:${key}`,
      provider: 'openai',
      name: 'ChatGPT',
      email: list.find((c) => c.email)?.email || null,
      plan: null,
      sources: [...new Set(list.map((c) => c.source))],
    };
    try {
      const usage = await withFirstWorking(list, (c) =>
        getJson('https://chatgpt.com/backend-api/wham/usage', {
          Authorization: `Bearer ${c.token}`,
          ...(c.accountId && { 'ChatGPT-Account-Id': c.accountId }),
          'User-Agent': 'codex_cli_rs/0.162.1',
          Accept: 'application/json',
        }),
      );
      accounts.push({
        ...base,
        email: usage.email || base.email,
        plan: titleCase(usage.plan_type),
        windows: codexWindows(usage),
        limitReached: Boolean(usage.rate_limit?.limit_reached),
        credits: usage.credits?.has_credits ? usage.credits.balance : null,
      });
    } catch (err) {
      accounts.push({ ...base, error: describeError(err, 'openai') });
    }
  }
  return accounts;
}

function describeError(err, provider) {
  if (err?.status === 401 || err?.status === 403) {
    return provider === 'claude'
      ? 'Login token expired. Run `claude` once and it will refresh.'
      : 'Login token expired. Run `codex` once (or start VibeProxy for CLIProxyAPI accounts).';
  }
  if (err?.status === 429) return 'Rate-limited by the usage endpoint; will retry shortly.';
  return `Usage request failed (${err?.message || err}).`;
}

// ---------- collection, caching, last-known-good ----------

let lastGood = readJson(LAST_GOOD_FILE) || {};
function saveLastGood() {
  fs.mkdirSync(path.dirname(LAST_GOOD_FILE), { recursive: true });
  fs.writeFileSync(LAST_GOOD_FILE, JSON.stringify(lastGood, null, 1));
}

async function collect(force) {
  const now = Date.now();
  const settled = await Promise.allSettled([fetchClaude(force), fetchCodex()]);
  const accounts = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  let changed = false;
  for (const a of accounts) {
    if (!a.error) {
      a.fetchedAt = now;
      lastGood[a.id] = a;
      changed = true;
    } else if (lastGood[a.id]) {
      // Fall back to the last successful reading; the UI marks it stale.
      Object.assign(a, { ...lastGood[a.id], error: a.error, stale: true, sources: a.sources });
    }
  }
  if (changed) saveLastGood();
  const order = { claude: 0, openai: 1 };
  accounts.sort((a, b) => order[a.provider] - order[b.provider] || (a.plan === 'Free') - (b.plan === 'Free'));
  return { generatedAt: now, accounts };
}

let cache = null;
let inflight = null;
async function getQuotas(force) {
  const age = cache ? Date.now() - cache.generatedAt : Infinity;
  if (cache && age < (force ? FORCE_MIN_MS : TTL_MS)) return cache;
  inflight ??= collect(force)
    .then((r) => (cache = r))
    .finally(() => (inflight = null));
  return inflight;
}

// ---------- entry points ----------

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(await getQuotas(true), null, 2));
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to known hosts, so other websites can't read this via DNS rebinding.
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/quotas') {
      const data = await getQuotas(url.searchParams.has('force'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(HERE, 'index.html')));
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`AI quota dashboard → http://localhost:${PORT}`));
