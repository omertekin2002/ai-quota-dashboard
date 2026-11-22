// Google Antigravity quotas using the OAuth login saved by T3 Code. No AGY process or
// model turn is needed. Credential files are only read; renewed access tokens stay in memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const DURATIONS = { '5h': 18000, weekly: 604800 };
const LOGIN_ERROR = 'Google login expired or was revoked. Sign in to Antigravity again in T3 Code.';
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const list = (v) => Array.isArray(v) ? v : [];
const time = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const fraction = (v) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function antigravityCredentials(t3StateDir) {
  const root = path.join(t3StateDir, 'providers', 'antigravity');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const credentials = new Map();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name, 'antigravity-acp');
    const authType = readJson(path.join(dir, 'settings.json'))?.auth?.type;
    // The personal token file is not the credential source for enterprise/API-key logins.
    if (authType && authType !== 'oauth-personal') continue;
    const file = path.join(dir, 'acp_token.json');
    if (!fs.existsSync(file)) continue;
    const token = readJson(file);
    const valid = token && ['client_id', 'client_secret', 'refresh_token'].every((k) => nonempty(token[k]));
    const project = nonempty(token?.project_id) ? token.project_id : null;
    // Include the login, not just the profile path: switching accounts must never revive
    // another account's last-good reading. Identical logins across profiles show once.
    const key = digest(valid ? JSON.stringify([token.client_id, token.refresh_token, project]) : file);
    credentials.set(key, { key, token: valid ? token : null, project });
  }
  return [...credentials.values()];
}

// `scope` is the model family the window alone limits. Antigravity has no account-wide window.
function window(id, label, quota, windowSec, scope) {
  const remaining = fraction(quota?.remainingFraction);
  return {
    id, label, usedPct: remaining == null ? null : (1 - remaining) * 100,
    resetsAt: time(quota?.resetTime), windowSec, scope,
    ...(windowSec == null ? { resetUnknown: true } : {}),
  };
}

function mergeWindows(responses) {
  const windows = new Map();
  for (const w of responses.flat()) {
    const previous = windows.get(w.id);
    if (!previous || (w.usedPct != null && (previous.usedPct == null || w.usedPct > previous.usedPct))) windows.set(w.id, w);
  }
  return [...windows.values()].sort((a, b) => (a.windowSec ?? Infinity) - (b.windowSec ?? Infinity) || a.label.localeCompare(b.label));
}

export function antigravitySummaryWindows(summary, requestedAt = Date.now()) {
  const groups = list(summary?.groups).some((g) => list(g?.buckets).length)
    ? summary.groups : [{ buckets: summary?.buckets }];
  const windows = [];
  for (const group of groups) for (const bucket of list(group?.buckets)) {
    if (!bucket || !nonempty(bucket.bucketId) || bucket.disabled) continue;
    const groupName = typeof group.displayName === 'string' ? group.displayName.trim() : '';
    const family = bucket.bucketId.startsWith('gemini-argon-') ? groupName || 'Gemini Argon'
      : bucket.bucketId.startsWith('gemini-') ? 'Gemini'
      : bucket.bucketId.startsWith('3p-') ? 'Claude & GPT (shared)'
      : groupName || bucket.bucketId;
    const duration = Object.hasOwn(DURATIONS, bucket.window) ? DURATIONS[bucket.window] : null;
    const cadence = bucket.window === '5h' ? '5-hour' : bucket.window === 'weekly' ? 'Weekly'
      : typeof bucket.displayName === 'string' ? bucket.displayName : 'Quota';
    const w = window(bucket.bucketId, `${family} · ${cadence}`, bucket, duration, family);
    // Google gives untouched buckets a moving now+duration reset. That is not a
    // running window, so don't turn it into a countdown or a pace projection.
    if (bucket.remainingFraction === 1 && bucket.description == null && duration && w.resetsAt != null
      && Math.abs(w.resetsAt - requestedAt - duration * 1000) <= 60_000) w.resetsAt = null;
    windows.push(w);
  }
  return mergeWindows([windows]);
}

export function antigravityModelWindows(response) {
  const windows = [];
  if (!response?.models || typeof response.models !== 'object' || Array.isArray(response.models)) return windows;
  for (const [id, model] of Object.entries(response.models)) {
    if (!model || typeof model !== 'object') continue;
    const family = model.modelProvider === 'MODEL_PROVIDER_GOOGLE' || id.startsWith('gemini-') ? 'Gemini'
      : model.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || id.startsWith('claude-') ? 'Claude'
      : model.modelProvider === 'MODEL_PROVIDER_OPENAI' || id.startsWith('gpt-') ? 'GPT' : null;
    if (!family) continue;
    for (const [key, suffix, label, duration] of [
      ['quotaInfo', 'quota', 'Reported quota', null], ['weeklyQuotaInfo', 'weekly', 'Weekly', 604800],
    ]) {
      if (model[key]) windows.push(window(`${family.toLowerCase()}-${suffix}`, `${family} · ${label}`, model[key], duration, family));
    }
  }
  return mergeWindows([windows]);
}

// The options also allow short timeouts in tests. All destinations are fixed, including
// OAuth: token_uri and other URLs in credential files are never followed.
export function createAntigravityCollector({ t3StateDir, fetchImpl = fetch, now = Date.now,
  platform = process.platform, requestTimeoutMs = 10_000, accountTimeoutMs = 30_000 }) {
  const accessTokens = new Map();
  async function request(url, init, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  async function readAccount(cred) {
    const base = { id: `antigravity:${cred.key.slice(0, 24)}`, provider: 'antigravity', name: 'Antigravity',
      email: accessTokens.get(cred.key)?.email || null, plan: null, sources: ['T3 Code'] };
    if (!cred.token) return { ...base, error: 'Could not read the saved Antigravity login. Sign in again in T3 Code.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), accountTimeoutMs);
    const { signal } = controller;
    try {
      let cached = accessTokens.get(cred.key);
      if (!cached || cached.expiresAt <= now() + 60_000) {
        accessTokens.delete(cred.key);
        let refreshed;
        try {
          refreshed = await request('https://oauth2.googleapis.com/token', {
            method: 'POST', body: new URLSearchParams({ client_id: cred.token.client_id,
              client_secret: cred.token.client_secret, refresh_token: cred.token.refresh_token, grant_type: 'refresh_token' }),
          }, signal);
        } catch (err) {
          if ([400, 401, 403].includes(err?.status)) throw new Error(LOGIN_ERROR);
          throw err;
        }
        if (!nonempty(refreshed?.access_token) || !Number.isFinite(refreshed.expires_in) || refreshed.expires_in <= 0) {
          throw new Error('Invalid OAuth response');
        }
        cached = { token: refreshed.access_token, expiresAt: now() + refreshed.expires_in * 1000, email: base.email };
        // Account email is optional; a profile lookup failure must not block quotas.
        const info = await request('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${cached.token}` },
        }, signal).catch(() => null);
        if (nonempty(info?.email)) cached.email = info.email;
        accessTokens.set(cred.key, cached);
      }
      base.email = cached.email;
      const query = async (operation, parse) => {
        const responses = await Promise.allSettled(ENDPOINTS.map(async (endpoint) => {
          const requestedAt = now();
          const data = await request(`${endpoint}/v1internal:${operation}`, {
            method: 'POST', headers: { Authorization: `Bearer ${cached.token}`, 'Content-Type': 'application/json',
              'User-Agent': `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${process.arch}; cl=963137146)` },
            body: JSON.stringify(cred.project ? { project: cred.project } : {}),
          }, signal);
          return parse(data, requestedAt);
        }));
        const windows = mergeWindows(responses.filter((r) => r.status === 'fulfilled').map((r) => r.value));
        return { windows, error: responses.find((r) => r.status === 'rejected')?.reason };
      };
      let result = await query('retrieveUserQuotaSummary', antigravitySummaryWindows);
      if (!result.windows.some((w) => w.usedPct != null)) {
        const fallback = await query('fetchAvailableModels', antigravityModelWindows);
        result = { windows: fallback.windows, error: fallback.error || result.error };
      }
      if (!result.windows.some((w) => w.usedPct != null)) throw result.error || new Error('No quota data');
      return { ...base, windows: result.windows, limitReached: result.windows.some((w) => w.usedPct >= 100) };
    } catch (err) {
      if ([401, 403].includes(err?.status)) accessTokens.delete(cred.key);
      // Never expose response bodies or arbitrary fetch errors: either can contain credentials.
      const error = err?.message === LOGIN_ERROR || [401, 403].includes(err?.status) ? LOGIN_ERROR
        : err?.status === 429 ? 'Rate-limited by the usage endpoint; will retry shortly.'
        : 'Could not read Antigravity quotas. Will retry on the next refresh.';
      return { ...base, error };
    } finally { clearTimeout(timer); }
  }

  return async function collectAntigravity() {
    const credentials = antigravityCredentials(t3StateDir);
    const present = new Set(credentials.map((c) => c.key));
    for (const key of accessTokens.keys()) if (!present.has(key)) accessTokens.delete(key);
    // Like the other providers, bound the work by collecting saved logins in order.
    const accounts = [];
    for (const cred of credentials) accounts.push(await readAccount(cred));
    return accounts;
  };
}
