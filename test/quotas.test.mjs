import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuotaCollector, claudeWindows, claudeNoSessionLimit, claudePlan, codexWindows, windowLabel, describeError, pct } from '../quotas.mjs';
import { parseAllowedHosts, isAllowedHost } from '../hosts.mjs';

const NOW = Date.UTC(2026, 9, 25, 12);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-collector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }
  return { root, home: path.join(root, 'home'), authDir: path.join(root, 'proxy'), codexHome: path.join(root, 'codex'), lastGoodFile: path.join(root, 'cache', 'last-good.json'), platform: 'linux' };
}

// Answers the three upstream endpoints from `routes`, keyed by endpoint and then by bearer token.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, { headers }) => {
    const token = headers.Authorization.replace('Bearer ', '');
    const endpoint = url.endsWith('/profile') ? 'profile' : url.endsWith('/oauth/usage') ? 'claude' : 'codex';
    calls.push({ endpoint, token });
    const reply = routes[endpoint]?.[token] ?? 500;
    return typeof reply === 'number' ? new Response('nope', { status: reply }) : Response.json(reply);
  };
  return { fetchImpl, calls };
}

test('importing the quota module starts no server, timers or requests', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "await import('./quotas.mjs'); console.log('ok')"], { cwd: ROOT, timeout: 5000 });
  assert.equal(stdout.trim(), 'ok');
});

test('claudeWindows reads fixed windows, model-scoped limits and extra usage', () => {
  const windows = claudeWindows({
    five_hour: { utilization: 42, resets_at: '2026-10-25T15:00:00Z' },
    seven_day: { resets_at: 1_793_000_000 },
    seven_day_opus: { utilization: 10 },
    seven_day_sonnet: { utilization: 20 },
    limits: [
      { group: 'weekly', percent: 70, resets_at: '2026-10-30T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
      { group: 'weekly', percent: 99, scope: { model: { display_name: 'Opus' } } },
      { group: 'session', percent: 5 },
      { group: 'burst', scope: { model: { display_name: 'Haiku' } } },
    ],
    weekly_scoped_shares: [{ limit_index: 0, allowance_percent_of_weekly: 25 }],
    extra_usage: { is_enabled: true, utilization: 12.5 },
  });
  assert.deepEqual(windows.map((w) => [w.id, w.label, w.usedPct, w.windowSec]), [
    ['five_hour', '5-hour', 42, 18000],
    ['seven_day', 'Weekly', null, 604800],
    ['seven_day_opus', 'Weekly · Opus', 10, 604800],
    ['seven_day_sonnet', 'Weekly · Sonnet', 20, 604800],
    ['weekly_fable', 'Weekly · Fable', 70, 604800],
    ['burst_haiku', 'Burst · Haiku', null, null],
    ['extra_usage', 'Extra usage · monthly', 12.5, null],
  ]);
  assert.equal(windows[0].resetsAt, Date.parse('2026-10-25T15:00:00Z'));
  assert.equal(windows[1].resetsAt, 1_793_000_000_000);
  assert.equal(windows[4].shareOfWeeklyPct, 25);
  assert.equal(windows[5].shareOfWeeklyPct, null);
  assert.deepEqual(claudeWindows({ extra_usage: { is_enabled: false, utilization: 50 } }), []);
});

test('missing, null or non-numeric usage stays unknown instead of reading as 0', () => {
  assert.deepEqual([42, 0, '12.5', ' 7 ', null, undefined, '', 'n/a', NaN, Infinity, true, {}, []].map(pct), [42, 0, 12.5, 7, null, null, null, null, null, null, null, null, null]);
  const claude = claudeWindows({
    five_hour: { utilization: null },
    seven_day: { utilization: 'lots' },
    seven_day_opus: { utilization: '30' },
    limits: [{ group: 'weekly', percent: null, scope: { model: { display_name: 'Fable' } } }],
    extra_usage: { is_enabled: true, utilization: 'n/a' },
  });
  assert.deepEqual(claude.map((w) => [w.id, w.usedPct]), [['five_hour', null], ['seven_day', null], ['seven_day_opus', 30], ['weekly_fable', null]]);
  const codex = codexWindows({ rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000 }, secondary_window: { used_percent: 'x', limit_window_seconds: 604800 } } }, NOW);
  assert.deepEqual(codex.map((w) => w.usedPct), [null, null]);
});

test('claudePlan prefers the live profile and falls back to the saved subscription type', () => {
  assert.equal(claudePlan({ organization: { rate_limit_tier: 'default_claude_max_20x' } }, 'pro'), 'Max 20x');
  assert.equal(claudePlan({ account: { has_claude_max: true }, organization: {} }, 'pro'), 'Max');
  assert.equal(claudePlan({ organization: { organization_type: 'claude_team_plan' } }, 'pro'), 'Team plan');
  assert.equal(claudePlan(null, 'pro'), 'Pro');
  assert.equal(claudePlan(null, undefined), null);
});

test('codexWindows labels every window shape the usage endpoint returns', () => {
  const windows = codexWindows({
    rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_793_000_000 },
      secondary_window: { limit_window_seconds: 604800, reset_after_seconds: 60 },
    },
    additional_rate_limits: [
      { limit_name: 'GPT-5 Pro', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 30 * 86400 } } },
      { rate_limit: { secondary_window: { used_percent: 2, limit_window_seconds: 2 * 86400 } } },
    ],
    code_review_rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 3 * 3600 } },
  }, NOW);
  assert.deepEqual(windows.map((w) => [w.id, w.label, w.usedPct]), [
    ['primary', '5-hour', 30],
    ['secondary', 'Weekly', null],
    ['extra-0-primary', 'GPT-5 Pro · Monthly', 1],
    ['extra-1-secondary', 'Limit 2 · 2-day', 2],
    ['code-review-primary', 'Code review · 3-hour', 3],
  ]);
  assert.equal(windows[0].resetsAt, 1_793_000_000_000);
  assert.equal(windows[1].resetsAt, NOW + 60_000);
  assert.equal(windows[2].resetsAt, null);
  const nested = codexWindows({ code_review_rate_limit: { rate_limit: { secondary_window: { used_percent: 4, limit_window_seconds: 5400 } } } }, NOW);
  assert.deepEqual(nested.map((w) => [w.id, w.label]), [['code-review-secondary', 'Code review · 90-min']]);
  assert.deepEqual([null, 18000, 604800, 28 * 86400, 31 * 86400, 86400, 7200, 90].map(windowLabel),
    [null, '5-hour', 'Weekly', 'Monthly', 'Monthly', '1-day', '2-hour', '2-min']);
});

test('describeError explains auth, rate-limit and other failures per provider', () => {
  assert.match(describeError({ status: 401 }, 'claude'), /Run `claude` once/);
  assert.match(describeError({ status: 403 }, 'openai'), /Run `codex` once/);
  assert.equal(describeError({ status: 429 }, 'claude'), 'Rate-limited by the usage endpoint; will retry shortly.');
  assert.equal(describeError(new Error('HTTP 500'), 'openai'), 'Usage request failed (HTTP 500).');
});

const codexToken = jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
const accountFiles = {
  'home/.claude/.credentials.json': { claudeAiOauth: { accessToken: 'claude-file-token', expiresAt: NOW - 1000, subscriptionType: 'pro' } },
  'proxy/claude-a.json': { type: 'claude', access_token: 'claude-proxy-token', expired: new Date(NOW + 3600_000).toISOString(), email: 'a@example.com' },
  'proxy/claude-off.json': { type: 'claude', disabled: true, access_token: 'claude-disabled-token' },
  'proxy/gemini.json': { type: 'gemini', access_token: 'gemini-token' },
  'proxy/notes.txt': 'ignored',
  'codex/auth.json': { tokens: { access_token: codexToken, id_token: jwt({ email: 'c@example.com' }) } },
  'proxy/codex-a.json': { type: 'codex', access_token: `${codexToken}x`, account_id: 'acct-1' },
};
const profile = { account: { email: 'a@example.com' }, organization: { rate_limit_tier: 'default_claude_max_5x' } };
const healthyRoutes = {
  profile: { 'claude-file-token': profile, 'claude-proxy-token': profile },
  claude: { 'claude-proxy-token': { five_hour: { utilization: 100 } } },
  codex: { [codexToken]: { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000 } }, credits: { has_credits: true, balance: 5 } } },
};

test('discovers each account once across sources and skips expired or disabled credentials', async (t) => {
  const { fetchImpl, calls } = fakeFetch(healthyRoutes);
  const opts = await fixture(t, accountFiles);
  const { accounts } = await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true);
  assert.equal(accounts.length, 2);
  const [claude, codex] = accounts;
  assert.deepEqual([claude.id, claude.email, claude.plan, claude.sources, claude.limitReached], ['claude:a@example.com', 'a@example.com', 'Max 5x', ['CLIProxyAPI', 'Claude Code'], true]);
  assert.deepEqual([codex.id, codex.email, codex.plan, codex.sources, codex.credits], ['openai:acct-1', 'c@example.com', 'Plus', ['Codex CLI', 'CLIProxyAPI'], 5]);
  assert.equal(codex.windows[0].label, '5-hour');
  const used = calls.map((c) => c.token);
  assert.ok(!used.includes('claude-disabled-token') && !used.includes('gemini-token'));
  // The expired Claude Code token is never used for the usage request.
  assert.deepEqual(calls.filter((c) => c.endpoint === 'claude').map((c) => c.token), ['claude-proxy-token']);
});

test('an account with only an expired token reports a login error without calling the endpoint', async (t) => {
  const { fetchImpl, calls } = fakeFetch({});
  const opts = await fixture(t, { 'home/.claude/.credentials.json': accountFiles['home/.claude/.credentials.json'] });
  const { accounts } = await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].plan, 'Pro');
  assert.match(accounts[0].error, /Run `claude` once/);
  assert.ok(!calls.some((c) => c.endpoint === 'claude'));
});

test('failed accounts fall back to their last good reading and never leak tokens', async (t) => {
  let clock = NOW;
  const routes = structuredClone(healthyRoutes);
  const { fetchImpl } = fakeFetch(routes);
  const opts = await fixture(t, accountFiles);
  const getQuotas = createQuotaCollector({ ...opts, fetchImpl, now: () => clock });
  const first = await getQuotas(true);
  assert.ok(first.accounts.every((a) => !a.error && a.fetchedAt === NOW));

  routes.claude['claude-proxy-token'] = 500;
  routes.codex[codexToken] = routes.codex[`${codexToken}x`] = 429;
  clock += 20_000;
  const second = await getQuotas(true);
  assert.equal(second.accounts.length, 2);
  const [claude, codex] = second.accounts;
  // Every credential failed, so the error is the last one tried: here the expired Claude Code token.
  assert.deepEqual([claude.stale, claude.error, claude.fetchedAt], [true, 'Login token expired. Run `claude` once and it will refresh.', NOW]);
  assert.deepEqual(claude.windows, first.accounts[0].windows);
  assert.deepEqual([codex.stale, codex.error, codex.windows[0].usedPct], [true, 'Rate-limited by the usage endpoint; will retry shortly.', 9]);

  // A fresh collector (e.g. after a restart) reads the saved last-good file.
  const restarted = await createQuotaCollector({ ...opts, fetchImpl, now: () => clock })(true);
  assert.equal(restarted.accounts[0].stale, true);

  const saved = await readFile(opts.lastGoodFile, 'utf8');
  for (const text of [saved, JSON.stringify(first), JSON.stringify(second)]) {
    for (const token of ['claude-file-token', 'claude-proxy-token', codexToken]) assert.ok(!text.includes(token), token);
  }
});

test('an account whose usage is unreadable is not reported as limit reached', async (t) => {
  const routes = structuredClone(healthyRoutes);
  routes.claude['claude-proxy-token'] = { five_hour: { utilization: null }, seven_day: { utilization: 'full' } };
  const { fetchImpl } = fakeFetch(routes);
  const opts = await fixture(t, accountFiles);
  const [claude] = (await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true)).accounts;
  assert.deepEqual([claude.error, claude.limitReached, claude.windows.map((w) => w.usedPct)], [undefined, false, [null, null]]);
});

test('an explicit five_hour: null flags the Claude account as having no 5-hour limit, and nothing else does', async (t) => {
  const cases = [
    [{ five_hour: null, seven_day: { utilization: 20 } }, true, [['seven_day', 20]]],
    [{ seven_day: { utilization: 20 } }, undefined, [['seven_day', 20]]],
    [{ five_hour: { utilization: null }, seven_day: { utilization: 20 } }, undefined, [['five_hour', null], ['seven_day', 20]]],
    [{ five_hour: { utilization: 30 }, seven_day: { utilization: 20 } }, undefined, [['five_hour', 30], ['seven_day', 20]]],
  ];
  for (const [usage, flag, windows] of cases) {
    const routes = structuredClone(healthyRoutes);
    routes.claude['claude-proxy-token'] = usage;
    const { fetchImpl } = fakeFetch(routes);
    const opts = await fixture(t, accountFiles);
    const [claude, codex] = (await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true)).accounts;
    assert.equal(claude.noSessionLimit, flag, JSON.stringify(usage));
    assert.deepEqual(claude.windows.map((w) => [w.id, w.usedPct]), windows);
    assert.ok(!('noSessionLimit' in codex));
  }
  assert.deepEqual([null, undefined, {}, { five_hour: undefined }, { five_hour: 0 }, { five_hour: null }].map(claudeNoSessionLimit), [false, false, false, false, false, true]);
});

test('a failed read never sets the flag, and a stale account keeps the flag from its last good reading', async (t) => {
  let clock = NOW;
  const routes = structuredClone(healthyRoutes);
  routes.claude['claude-proxy-token'] = 500;
  const { fetchImpl } = fakeFetch(routes);
  const opts = await fixture(t, accountFiles);
  const getQuotas = createQuotaCollector({ ...opts, fetchImpl, now: () => clock });
  const failed = (await getQuotas(true)).accounts[0];
  assert.ok(failed.error && !('noSessionLimit' in failed));

  routes.claude['claude-proxy-token'] = { five_hour: null, seven_day: { utilization: 20 } };
  clock += 20_000;
  assert.equal((await getQuotas(true)).accounts[0].noSessionLimit, true);

  routes.claude['claude-proxy-token'] = 500;
  clock += 20_000;
  const stale = (await getQuotas(true)).accounts[0];
  assert.deepEqual([stale.stale, stale.noSessionLimit, stale.windows.map((w) => w.id)], [true, true, ['seven_day']]);
});

test('last-good.json is saved atomically and privately', async (t) => {
  const { fetchImpl } = fakeFetch(healthyRoutes);
  const opts = await fixture(t, accountFiles);
  await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true);
  assert.deepEqual(await readdir(path.dirname(opts.lastGoodFile)), ['last-good.json']);
  assert.equal((await stat(opts.lastGoodFile)).mode & 0o777, 0o600);
  assert.equal(Object.keys(JSON.parse(await readFile(opts.lastGoodFile, 'utf8'))).length, 2);
});

test('a failed last-good save is logged and the live readings are still returned', async (t) => {
  const { fetchImpl } = fakeFetch(healthyRoutes);
  const opts = await fixture(t, { ...accountFiles, blocker: 'a file, not a directory' });
  const errors = t.mock.method(console, 'error', () => {});
  const getQuotas = createQuotaCollector({ ...opts, lastGoodFile: path.join(opts.root, 'blocker', 'last-good.json'), fetchImpl, now: () => NOW });
  const { accounts } = await getQuotas(true);
  assert.deepEqual(accounts.map((a) => [a.provider, a.error ?? null, a.windows.length]), [['claude', null, 1], ['openai', null, 1]]);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /Could not save the last good reading/);
  assert.ok(!errors.mock.calls[0].arguments[0].includes('a@example.com'));
});

test('one provider failing keeps the other provider\'s accounts', async (t) => {
  const { fetchImpl } = fakeFetch({ ...healthyRoutes, codex: { [codexToken]: 403, [`${codexToken}x`]: 403 } });
  const opts = await fixture(t, accountFiles);
  const { accounts } = await createQuotaCollector({ ...opts, fetchImpl, now: () => NOW })(true);
  assert.deepEqual(accounts.map((a) => [a.provider, Boolean(a.windows), a.error ?? null]), [
    ['claude', true, null],
    ['openai', false, 'Login token expired. Run `codex` once (or start VibeProxy for CLIProxyAPI accounts).'],
  ]);
});

test('caches for 90 seconds, 15 seconds on manual refresh, and shares in-flight rounds', async (t) => {
  let clock = NOW;
  const { fetchImpl, calls } = fakeFetch(healthyRoutes);
  const opts = await fixture(t, accountFiles);
  const getQuotas = createQuotaCollector({ ...opts, fetchImpl, now: () => clock });
  const usageCalls = () => calls.filter((c) => c.endpoint !== 'profile').length;
  const [a, b] = await Promise.all([getQuotas(), getQuotas()]);
  assert.equal(a, b);
  assert.equal(usageCalls(), 2);
  clock += 14_000;
  assert.equal(await getQuotas(true), a);
  clock += 2_000;
  assert.notEqual(await getQuotas(true), a);
  assert.equal(usageCalls(), 4);
  clock += 89_000;
  await getQuotas();
  assert.equal(usageCalls(), 4);
  clock += 2_000;
  await getQuotas();
  assert.equal(usageCalls(), 6);
});

test('the Host allow-list accepts localhost and ALLOWED_HOSTS entries only', () => {
  const allowed = parseAllowedHosts(' Laptop.Tailnet.ts.net. , ,other.example');
  for (const host of ['localhost', 'localhost:7417', '127.0.0.1:7417', 'LAPTOP.tailnet.ts.net', 'laptop.tailnet.ts.net:8443', 'other.example']) {
    assert.ok(isAllowedHost(host, allowed), host);
  }
  for (const host of ['evil.example', 'localhost.evil.example', '', undefined, '[::1]:7417']) assert.ok(!isAllowedHost(host, allowed), String(host));
  assert.deepEqual([...parseAllowedHosts()], ['localhost', '127.0.0.1']);
});
