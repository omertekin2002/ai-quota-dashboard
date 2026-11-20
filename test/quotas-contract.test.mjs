// Contract test for GET /api/quotas: the fields build-workflow's src/quota.ts reads to pace workers
// and plans, decide on Codex reviews and pick council members. See "`/api/quotas` is an API" in README.md.
//
// The real collector (quotas.mjs + antigravity.mjs) runs against faked upstream replies and is served
// through the real HTTP server, so the checks see the serialized JSON build-workflow receives.
// Only names, types and units are pinned. Never compare whole accounts or windows here: additive
// fields must stay free to change.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createQuotaCollector } from '../quotas.mjs';
import { createDashboardServer } from '../server.mjs';

const NOW = Date.UTC(2026, 10, 20, 12);
const HOUR = 3600_000;
const FIVE_HOUR_SEC = 18000;
const WEEK_SEC = 604800;
const PROVIDERS = ['claude', 'openai', 'antigravity'];

// Every assertion message names the consumer, so a failure says what breaks downstream.
const reads = (field, what) => `contract: build-workflow src/quota.ts reads ${field} ${what}`;
// Epoch seconds for any date after 2001 are below 1e12; epoch ms are above it.
const isEpochMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 1e12;

// ---------- fixture: credentials on disk and fake upstream replies ----------

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
// No expiry on either login, so a unit bug in parsing dates fails on resetsAt instead of expiring the tokens.
const codexToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-contract' } });
const agyToken = { client_id: 'google-client', client_secret: 'client-secret', refresh_token: 'refresh-token', project_id: 'project-one' };

// Reset times the fixtures report, and the epoch-ms values the API must turn them into.
const CLAUDE_WEEK_RESET = '2026-11-24T08:00:00Z';
const CLAUDE_FIVE_RESET = '2026-11-20T14:00:00Z';
const CLAUDE_SESSION_FABLE_RESET = '2026-11-20T15:30:00Z';
const CODEX_PRIMARY_RESET_SEC = NOW / 1000 + 2 * 3600; // Codex sends epoch seconds
const CODEX_SECONDARY_RESET_SEC = NOW / 1000 + 3 * 86400;
const AGY_WEEK_RESET = new Date(NOW + 2 * 86400_000).toISOString();
const AGY_FIVE_RESET = new Date(NOW + HOUR).toISOString();

const claudeUsage = (overrides = {}) => ({
  five_hour: { utilization: 31, resets_at: CLAUDE_FIVE_RESET },
  seven_day: { utilization: 42, resets_at: CLAUDE_WEEK_RESET },
  // A model-scoped 5-hour limit: build-workflow finds these by windowSec === 18000, not by id.
  limits: [{ group: 'session', percent: 12, resets_at: CLAUDE_SESSION_FABLE_RESET, scope: { model: { display_name: 'Fable' } } }],
  ...overrides,
});
const codexUsage = () => ({
  plan_type: 'pro',
  rate_limit: {
    limit_reached: true,
    primary_window: { used_percent: 20, limit_window_seconds: FIVE_HOUR_SEC, reset_at: CODEX_PRIMARY_RESET_SEC },
    secondary_window: { used_percent: 55, limit_window_seconds: WEEK_SEC, reset_at: CODEX_SECONDARY_RESET_SEC },
  },
});
const agySummary = () => ({
  groups: [
    { displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: AGY_WEEK_RESET, description: 'used' },
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: AGY_FIVE_RESET, description: 'used' },
    ] },
    { displayName: 'Gemini 4 Argon', buckets: [
      { bucketId: 'gemini-argon-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: AGY_WEEK_RESET, description: 'used' },
    ] },
  ],
});

// `replies` maps each upstream to a JSON body, or to an HTTP status to fail with. Tests change it between reads.
function fakeUpstream(replies) {
  const reply = (value) => (typeof value === 'number' ? new Response('upstream failed', { status: value }) : Response.json(value));
  return async (url) => {
    if (url === 'https://api.anthropic.com/api/oauth/profile') return reply({ account: { email: 'claude@example.com' }, organization: { rate_limit_tier: 'default_claude_max_20x' } });
    if (url === 'https://api.anthropic.com/api/oauth/usage') return reply(replies.claude);
    if (url === 'https://chatgpt.com/backend-api/wham/usage') return reply(replies.codex);
    if (url === 'https://oauth2.googleapis.com/token') return reply({ access_token: 'google-access', expires_in: 3600 });
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return reply({ email: 'agy@example.com' });
    if (url.endsWith('/v1internal:retrieveUserQuotaSummary')) return reply(replies.antigravity);
    if (url.endsWith('/v1internal:fetchAvailableModels')) return reply(500);
    throw new Error(`unexpected request to ${url}`);
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// Starts the real dashboard server on a free port over a real collector with faked upstreams.
// `wrap` lets a test change the collector's result before it is served.
async function start(t, replies, wrap = (data) => data) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quotas-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const t3StateDir = path.join(root, 't3');
  await writeJson(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { accessToken: 'claude-token', subscriptionType: 'max' } });
  await writeJson(path.join(root, 'codex', 'auth.json'), { tokens: { access_token: codexToken } });
  const agyDir = path.join(t3StateDir, 'providers', 'antigravity', 'profile-a', 'antigravity-acp');
  await writeJson(path.join(agyDir, 'acp_token.json'), agyToken);
  await writeJson(path.join(agyDir, 'settings.json'), { auth: { type: 'oauth-personal' } });

  const clock = { now: NOW };
  const getQuotas = createQuotaCollector({
    home, authDir: path.join(root, 'proxy'), codexHome: path.join(root, 'codex'), t3StateDir, platform: 'linux',
    fetchImpl: fakeUpstream(replies), now: () => clock.now, lastGoodFile: path.join(root, 'cache', 'last-good.json'),
  });
  const server = createDashboardServer({
    getQuotas: async (force) => wrap(await getQuotas(force)),
    getWorkspaceStatus: async () => ({}),
    getPipelineOverview: async () => ({}),
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const { port } = server.address();

  // GET /api/quotas over HTTP and parse the body, as build-workflow does.
  async function readQuotas({ force = false } = {}) {
    const { status, type, body } = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: force ? '/api/quotas?force' : '/api/quotas', headers: { Host: `localhost:${port}` }, agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: text }));
      }).on('error', reject);
    });
    assert.equal(status, 200, reads('GET /api/quotas', 'and needs HTTP 200'));
    assert.match(type, /^application\/json/, reads('GET /api/quotas', 'as JSON'));
    return JSON.parse(body);
  }
  return { readQuotas, clock };
}

// ---------- the contract ----------

// The shape every account and window must have. Returns the accounts keyed by provider.
function checkShape(data) {
  assert.ok(data && Array.isArray(data.accounts), reads('accounts', 'as an array at the top level'));
  const byProvider = {};
  for (const [i, a] of data.accounts.entries()) {
    const at = `accounts[${i}]`;
    assert.ok(PROVIDERS.includes(a.provider), reads(`${at}.provider`, `as one of ${PROVIDERS.join(', ')} (got ${JSON.stringify(a.provider)})`));
    assert.ok(Array.isArray(a.windows), reads(`${at}.windows`, 'as an array'));
    assert.ok(!('limitReached' in a) || typeof a.limitReached === 'boolean', reads(`${at}.limitReached`, 'as a boolean when present'));
    assert.ok(isEpochMs(a.fetchedAt), reads(`${at}.fetchedAt`, `as epoch ms (got ${JSON.stringify(a.fetchedAt)})`));
    for (const [j, w] of a.windows.entries()) {
      const wat = `${at}.windows[${j}]`;
      assert.equal(typeof w.id, 'string', reads(`${wat}.id`, 'as a string'));
      assert.ok('usedPct' in w && (w.usedPct === null || (typeof w.usedPct === 'number' && Number.isFinite(w.usedPct))),
        reads(`${wat}.usedPct`, `as a number or null (window ${w.id})`));
      assert.ok('resetsAt' in w && (w.resetsAt === null || isEpochMs(w.resetsAt)),
        reads(`${wat}.resetsAt`, `as epoch ms or null (window ${w.id}, got ${JSON.stringify(w.resetsAt)})`));
      assert.ok('windowSec' in w && (w.windowSec === null || (typeof w.windowSec === 'number' && w.windowSec > 0)),
        reads(`${wat}.windowSec`, `as a number of seconds or null (window ${w.id})`));
    }
    byProvider[a.provider] = a;
  }
  return byProvider;
}

function findWindow(account, id, field) {
  const w = account.windows.find((x) => x.id === id);
  assert.ok(w, reads(field, `and found no window with id "${id}" (got ${account.windows.map((x) => x.id).join(', ')})`));
  return w;
}

// What a healthy reading of the fixtures above must contain.
function checkHealthy(byProvider, fetchedAt) {
  for (const provider of PROVIDERS) {
    const a = byProvider[provider];
    assert.ok(a, reads('accounts[].provider', `and found no "${provider}" account`));
    assert.equal(a.fetchedAt, fetchedAt, reads(`accounts[].fetchedAt (${provider})`, 'as the epoch-ms time of the reading'));
  }
  const { claude, openai, antigravity } = byProvider;

  const week = findWindow(claude, 'seven_day', "the Claude weekly window as accounts[].windows[].id 'seven_day'");
  assert.equal(week.windowSec, WEEK_SEC, reads("Claude 'seven_day' windowSec", 'as 604800'));
  assert.equal(week.usedPct, 42, reads("Claude 'seven_day' usedPct", 'as a percentage'));
  assert.equal(week.resetsAt, Date.parse(CLAUDE_WEEK_RESET), reads("Claude 'seven_day' resetsAt", 'as epoch ms'));
  const five = findWindow(claude, 'five_hour', "the Claude 5-hour window as accounts[].windows[].id 'five_hour'");
  assert.equal(five.windowSec, FIVE_HOUR_SEC, reads("Claude 'five_hour' windowSec", 'as 18000'));
  assert.equal(five.resetsAt, Date.parse(CLAUDE_FIVE_RESET), reads("Claude 'five_hour' resetsAt", 'as epoch ms'));
  const scoped = claude.windows.filter((w) => w.id !== 'five_hour' && w.windowSec === FIVE_HOUR_SEC);
  assert.equal(scoped.length, 1, reads('Claude model-scoped 5-hour windows', 'by windowSec === 18000'));
  assert.equal(scoped[0].usedPct, 12, reads('Claude model-scoped 5-hour usedPct', 'as a percentage'));
  assert.equal(scoped[0].resetsAt, Date.parse(CLAUDE_SESSION_FABLE_RESET), reads('Claude model-scoped 5-hour resetsAt', 'as epoch ms'));
  assert.equal(claude.limitReached, false, reads('Claude limitReached', 'as a boolean on every successful reading'));

  const primary = findWindow(openai, 'primary', "the Codex 5-hour window as accounts[].windows[].id 'primary'");
  assert.equal(primary.windowSec, FIVE_HOUR_SEC, reads("Codex 'primary' windowSec", 'as 18000'));
  assert.equal(primary.usedPct, 20, reads("Codex 'primary' usedPct", 'as a percentage'));
  assert.equal(primary.resetsAt, CODEX_PRIMARY_RESET_SEC * 1000, reads("Codex 'primary' resetsAt", 'as epoch ms, not the seconds Codex sends'));
  const secondary = findWindow(openai, 'secondary', "the Codex weekly window as accounts[].windows[].id 'secondary'");
  assert.equal(secondary.windowSec, WEEK_SEC, reads("Codex 'secondary' windowSec", 'as 604800'));
  assert.equal(secondary.usedPct, 55, reads("Codex 'secondary' usedPct", 'as a percentage'));
  assert.equal(secondary.resetsAt, CODEX_SECONDARY_RESET_SEC * 1000, reads("Codex 'secondary' resetsAt", 'as epoch ms, not the seconds Codex sends'));
  assert.equal(openai.limitReached, true, reads('Codex limitReached', 'as true when Codex reports its limit reached'));

  const gemini = antigravity.windows.filter((w) => w.id.startsWith('gemini-') && !w.id.startsWith('gemini-argon-'));
  const argon = antigravity.windows.filter((w) => w.id.startsWith('gemini-argon-'));
  const geminiWeek = gemini.find((w) => w.windowSec === WEEK_SEC);
  assert.ok(geminiWeek, reads('Antigravity gemini-* windows', 'and found no weekly one (windowSec 604800)'));
  assert.ok(Math.abs(geminiWeek.usedPct - 60) < 1e-9, reads('Antigravity gemini-* usedPct', 'as a percentage used'));
  assert.equal(geminiWeek.resetsAt, Date.parse(AGY_WEEK_RESET), reads('Antigravity gemini-* resetsAt', 'as epoch ms'));
  assert.ok(gemini.some((w) => w.windowSec === FIVE_HOUR_SEC), reads('Antigravity gemini-* windows', 'and found no 5-hour one (windowSec 18000)'));
  assert.equal(argon.length, 1, reads('Antigravity gemini-argon-* windows', 'as their own bucket ids, told apart from gemini-*'));
  assert.equal(argon[0].windowSec, WEEK_SEC, reads('Antigravity gemini-argon-* windowSec', 'as 604800 for a weekly bucket'));
  assert.equal(typeof antigravity.limitReached, 'boolean', reads('Antigravity limitReached', 'as a boolean on every successful reading'));
}

test('contract: a healthy Claude, Codex and Antigravity reading keeps the fields build-workflow reads', async (t) => {
  const { readQuotas } = await start(t, { claude: claudeUsage(), codex: codexUsage(), antigravity: agySummary() });
  const data = await readQuotas();
  checkHealthy(checkShape(data), NOW);
});

test('contract: Claude with five_hour: null still serves the weekly window and no five_hour reading', async (t) => {
  const { readQuotas } = await start(t, { claude: claudeUsage({ five_hour: null, limits: [] }), codex: codexUsage(), antigravity: agySummary() });
  const { claude } = checkShape(await readQuotas());
  assert.ok(claude, reads('accounts[].provider', 'and found no "claude" account'));
  assert.equal(claude.fetchedAt, NOW, reads('accounts[].fetchedAt (claude)', 'as the epoch-ms time of the reading'));
  const week = findWindow(claude, 'seven_day', "the Claude weekly window as accounts[].windows[].id 'seven_day'");
  assert.deepEqual([week.windowSec, week.usedPct, week.resetsAt], [WEEK_SEC, 42, Date.parse(CLAUDE_WEEK_RESET)],
    reads("Claude 'seven_day'", 'with windowSec 604800, usedPct and resetsAt in epoch ms'));
  // build-workflow reads a missing 5-hour reading as "no 5-hour cap".
  assert.ok(!claude.windows.some((w) => (w.id === 'five_hour' || w.windowSec === FIVE_HOUR_SEC) && typeof w.usedPct === 'number'),
    reads('five_hour: null', 'as no 5-hour window with a usedPct'));
  assert.equal(claude.limitReached, false, reads('Claude limitReached', 'as a boolean on every successful reading'));
});

test('contract: a failed refresh serves the last good reading as stale with its original fetchedAt', async (t) => {
  const replies = { claude: claudeUsage(), codex: codexUsage(), antigravity: agySummary() };
  const { readQuotas, clock } = await start(t, replies);
  checkHealthy(checkShape(await readQuotas()), NOW);

  replies.claude = 500;
  replies.codex = 503;
  replies.antigravity = 500;
  clock.now = NOW + 20_000; // past the 15-second minimum between manual refreshes
  const data = await readQuotas({ force: true });
  const byProvider = checkShape(data);
  for (const provider of PROVIDERS) {
    const a = byProvider[provider];
    assert.ok(a, reads('accounts[].provider', `and found no "${provider}" account after a failed refresh`));
    assert.equal(a.stale, true, `${provider}: a failed refresh should be served from the last good reading`);
    assert.equal(a.fetchedAt, NOW, reads(`accounts[].fetchedAt (${provider})`,
      'to judge staleness, so a last-good fallback must keep the epoch-ms time of the successful reading, not the failed attempt'));
  }
  // The stale accounts still carry the windows build-workflow reads.
  checkHealthy(byProvider, NOW);
});

test('contract: new fields on accounts and windows do not break it (changes are additive)', async (t) => {
  const addFields = (data) => ({
    ...data,
    apiNote: 'new top-level field',
    accounts: data.accounts.map((a) => ({ ...a, newAccountField: { nested: true }, windows: a.windows.map((w) => ({ ...w, newWindowField: 7 })) })),
  });
  const { readQuotas } = await start(t, { claude: claudeUsage(), codex: codexUsage(), antigravity: agySummary() }, addFields);
  const data = await readQuotas();
  assert.equal(data.accounts[0].newAccountField.nested, true);
  checkHealthy(checkShape(data), NOW);
});
