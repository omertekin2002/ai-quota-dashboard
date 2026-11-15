// Quota collection for Claude, ChatGPT (Codex) and Antigravity: credential discovery, the usage
// endpoints, and the parsers that turn their replies into limit windows.
//
// Credentials are read from wherever the CLIs already keep them: the Claude Code Keychain item,
// ~/.claude/.credentials.json, ~/.codex/auth.json, and CLIProxyAPI's auth dir (~/.cli-proxy-api, used
// by VibeProxy). Claude/Codex tokens are never refreshed or written back. Antigravity's Google
// OAuth renewal and quota calls live in antigravity.mjs; its credential files are also read-only.
//
// Importing this module does nothing by itself; createQuotaCollector() returns the cached getter.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createAntigravityCollector } from './antigravity.mjs';

const TTL_MS = 90_000; // normal polling: at most one upstream round per 90s
const FORCE_MIN_MS = 15_000; // manual refresh: at most one per 15s
const PROFILE_TTL_MS = 15 * 60_000; // plan lookup: re-checked this often, and on every manual refresh

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
// A usage percentage as a finite number, or null when the reply's field is missing or unreadable.
// Never 0: an unreadable figure must not look like an untouched window.
export function pct(v) {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function getJson(env, url, headers) {
  const res = await env.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// ---------- credential discovery ----------
// `env` is the collector's settings: { home, authDir, codexHome, platform, fetchImpl, now }.

export function proxyAuthFiles(env, type) {
  let names;
  try {
    names = fs.readdirSync(env.authDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(env.authDir, n)))
    .filter((d) => d && d.type === type && !d.disabled && d.access_token);
}

export function claudeCredentials(env) {
  const creds = [];
  if (env.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const o = JSON.parse(raw).claudeAiOauth;
      if (o?.accessToken) creds.push({ token: o.accessToken, expiresAt: toMs(o.expiresAt), plan: o.subscriptionType, source: 'Claude Code' });
    } catch {}
  }
  const file = readJson(path.join(env.home, '.claude', '.credentials.json'))?.claudeAiOauth;
  if (file?.accessToken) creds.push({ token: file.accessToken, expiresAt: toMs(file.expiresAt), plan: file.subscriptionType, source: 'Claude Code' });
  for (const f of proxyAuthFiles(env, 'claude')) {
    creds.push({ token: f.access_token, expiresAt: toMs(f.expired), email: f.email, source: 'CLIProxyAPI' });
  }
  return creds;
}

export function codexCredential(token, accountId, idToken, source) {
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

export function codexCredentials(env) {
  const creds = [];
  const auth = readJson(path.join(env.codexHome, 'auth.json'));
  if (auth?.tokens?.access_token) {
    creds.push(codexCredential(auth.tokens.access_token, auth.tokens.account_id, auth.tokens.id_token, 'Codex CLI'));
  }
  for (const f of proxyAuthFiles(env, 'codex')) creds.push(codexCredential(f.access_token, f.account_id, f.id_token, 'CLIProxyAPI'));
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
async function withFirstWorking(env, list, fn) {
  let lastErr;
  for (const cred of list) {
    if (cred.expiresAt && cred.expiresAt < env.now()) {
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

async function claudeProfile(env, profileCache, cred, force) {
  const key = hash(cred.token);
  const hit = profileCache.get(key);
  if (hit && !force && env.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const profile = await getJson(env, 'https://api.anthropic.com/api/oauth/profile', claudeHeaders(cred.token)).catch(() => null);
  if (profile) profileCache.set(key, { at: env.now(), profile });
  // A failed re-check keeps the last answer instead of dropping to the plan saved at login.
  return profile ?? hit?.profile ?? null;
}

export function claudePlan(profile, fallback) {
  const org = profile?.organization || {};
  const tier = org.rate_limit_tier || '';
  if (profile?.account?.has_claude_max || tier.includes('max')) {
    const mult = tier.match(/(\d+)x/);
    return mult ? `Max ${mult[1]}x` : 'Max';
  }
  if (org.organization_type) return titleCase(org.organization_type.replace(/^claude_/, '').replace(/_/g, ' '));
  return titleCase(fallback) || null;
}

const LIMIT_GROUPS = { session: ['5-hour', 5 * 3600], weekly: ['Weekly', 7 * 86400] };

export function claudeWindows(u) {
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
      usedPct: pct(u[key].utilization),
      resetsAt: toMs(u[key].resets_at),
      windowSec,
    }));
  // Limits for a single model (e.g. Fable's own weekly cap) only appear in the newer `limits` list.
  (u.limits || []).forEach((l, i) => {
    const model = l.scope?.model?.display_name;
    if (!model) return;
    const [group, windowSec] = LIMIT_GROUPS[l.group] || [titleCase(l.group), null];
    const label = [group, model].filter(Boolean).join(' · ');
    if (windows.some((w) => w.label === label)) return;
    const share = u.weekly_scoped_shares?.find((s) => s.limit_index === i);
    windows.push({
      id: [l.group, model].filter(Boolean).join('_').toLowerCase().replace(/\W+/g, '_'),
      label,
      usedPct: pct(l.percent),
      resetsAt: toMs(l.resets_at),
      windowSec,
      shareOfWeeklyPct: share?.allowance_percent_of_weekly ?? null,
    });
  });
  if (u.extra_usage?.is_enabled && pct(u.extra_usage.utilization) != null) {
    windows.push({ id: 'extra_usage', label: 'Extra usage · monthly', usedPct: pct(u.extra_usage.utilization), resetsAt: null, windowSec: null });
  }
  return windows;
}

// True only when the usage response explicitly reports `five_hour: null`.
export function claudeNoSessionLimit(u) {
  return u?.five_hour === null;
}

async function fetchClaude(env, profileCache, force) {
  const creds = claudeCredentials(env);
  // Identify each token's account (email) so the same login from two sources shows once.
  for (const c of creds) {
    const p = await claudeProfile(env, profileCache, c, force);
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
      const usage = await withFirstWorking(env, list, (c) => getJson(env, 'https://api.anthropic.com/api/oauth/usage', claudeHeaders(c.token)));
      const windows = claudeWindows(usage);
      const account = { ...base, windows, limitReached: windows.some((w) => w.usedPct != null && w.usedPct >= 100) };
      // Anthropic sends `five_hour: null` when the account has no 5-hour cap right now. That is a reading,
      // unlike a missing key or `{ utilization: null }` (usage unknown), so the card can say so.
      if (claudeNoSessionLimit(usage)) account.noSessionLimit = true;
      accounts.push(account);
    } catch (err) {
      accounts.push({ ...base, error: describeError(err, 'claude') });
    }
  }
  return accounts;
}

// ---------- OpenAI / Codex ----------

export function windowLabel(sec) {
  if (!sec) return null;
  if (sec === 5 * 3600) return '5-hour';
  if (sec === 7 * 86400) return 'Weekly';
  if (sec >= 28 * 86400 && sec <= 31 * 86400) return 'Monthly';
  if (sec % 86400 === 0) return `${sec / 86400}-day`;
  if (sec % 3600 === 0) return `${sec / 3600}-hour`;
  return `${Math.round(sec / 60)}-min`;
}

export function codexWindows(u, now = Date.now()) {
  const windows = [];
  const add = (w, prefix, id) => {
    if (!w) return;
    windows.push({
      id,
      label: [prefix, windowLabel(w.limit_window_seconds)].filter(Boolean).join(' · '),
      usedPct: pct(w.used_percent),
      resetsAt: toMs(w.reset_at) ?? (w.reset_after_seconds != null ? now + w.reset_after_seconds * 1000 : null),
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

async function fetchCodex(env) {
  const groups = groupBy(codexCredentials(env), (c) => c.accountId || hash(c.token));
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
      const usage = await withFirstWorking(env, list, (c) =>
        getJson(env, 'https://chatgpt.com/backend-api/wham/usage', {
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
        windows: codexWindows(usage, env.now()),
        limitReached: Boolean(usage.rate_limit?.limit_reached),
        credits: usage.credits?.has_credits ? usage.credits.balance : null,
      });
    } catch (err) {
      accounts.push({ ...base, error: describeError(err, 'openai') });
    }
  }
  return accounts;
}

export function describeError(err, provider) {
  if (err?.status === 401 || err?.status === 403) {
    return provider === 'claude'
      ? 'Login token expired. Run `claude` once and it will refresh.'
      : 'Login token expired. Run `codex` once (or start VibeProxy for CLIProxyAPI accounts).';
  }
  if (err?.status === 429) return 'Rate-limited by the usage endpoint; will retry shortly.';
  return `Usage request failed (${err?.message || err}).`;
}

// ---------- collection, caching, last-known-good ----------

export function createQuotaCollector({
  home = os.homedir(),
  authDir = path.join(home, '.cli-proxy-api'),
  codexHome = path.join(home, '.codex'),
  t3StateDir = path.join(home, '.t3', 'userdata'),
  platform = process.platform,
  fetchImpl = fetch,
  now = Date.now,
  lastGoodFile = null,
} = {}) {
  const env = { home, authDir, codexHome, platform, fetchImpl, now };
  const profileCache = new Map();
  const fetchAntigravity = createAntigravityCollector({ t3StateDir, fetchImpl, now, platform });
  let lastGood = (lastGoodFile && readJson(lastGoodFile)) || {};
  // Written atomically (tmp file + rename) and private, since it holds account emails. A failed save
  // only loses the fallback for the next restart, so it's logged and the live readings are still served.
  function saveLastGood() {
    if (!lastGoodFile) return;
    const tmp = `${lastGoodFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(lastGoodFile), { recursive: true });
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, JSON.stringify(lastGood, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, lastGoodFile);
    } catch (err) {
      console.error(`Could not save the last good reading to ${lastGoodFile}: ${err.code || err.message}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }

  async function collect(force) {
    const at = now();
    const settled = await Promise.allSettled([fetchClaude(env, profileCache, force), fetchCodex(env), fetchAntigravity()]);
    const accounts = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    let changed = false;
    for (const a of accounts) {
      if (!a.error) {
        a.fetchedAt = at;
        lastGood[a.id] = a;
        changed = true;
      } else if (lastGood[a.id]) {
        // Fall back to the last successful reading; the UI marks it stale.
        Object.assign(a, { ...lastGood[a.id], error: a.error, stale: true, sources: a.sources });
      }
    }
    if (changed) saveLastGood();
    const order = { claude: 0, openai: 1, antigravity: 2 };
    accounts.sort((a, b) => order[a.provider] - order[b.provider] || (a.plan === 'Free') - (b.plan === 'Free'));
    return { generatedAt: at, accounts };
  }

  let cache = null;
  let inflight = null;
  return async function getQuotas(force) {
    const age = cache ? now() - cache.generatedAt : Infinity;
    if (cache && age < (force ? FORCE_MIN_MS : TTL_MS)) return cache;
    inflight ??= collect(force)
      .then((r) => (cache = r))
      .finally(() => (inflight = null));
    return inflight;
  };
}
