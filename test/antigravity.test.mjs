import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { antigravityCredentials, antigravitySummaryWindows, antigravityModelWindows, createAntigravityCollector } from '../antigravity.mjs';
import { createQuotaCollector } from '../quotas.mjs';

const NOW = Date.UTC(2026, 10, 3, 14);
const token = { client_id: 'google-client', client_secret: 'PRIVATE-CLIENT-SECRET', refresh_token: 'PRIVATE-REFRESH-TOKEN',
  project_id: 'project-one', token_uri: 'https://untrusted.example/token' };
const bucket = (bucketId, remainingFraction = 0.75, window = '5h', extra = {}) => ({
  bucketId, remainingFraction, window, resetTime: new Date(NOW + 3600_000).toISOString(), ...extra,
});
const summary = (...buckets) => ({ groups: [{ displayName: 'Gemini Models', buckets }] });

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-quotas-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const t3StateDir = path.join(home, '.t3', 'userdata');
  async function profile(name = 'profile-a', value = token, type = 'oauth-personal') {
    const dir = path.join(t3StateDir, 'providers', 'antigravity', name, 'antigravity-acp');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'acp_token.json');
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ auth: { type } }));
    return file;
  }
  return { home, t3StateDir, profile, now: () => NOW, lastGoodFile: path.join(home, 'last-good.json') };
}

function upstream(handler = () => summary(bucket('gemini-5h'))) {
  const calls = [];
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshes++;
      assert.ok(init.body instanceof URLSearchParams);
      assert.equal(init.body.get('refresh_token'), token.refresh_token);
      return Response.json({ access_token: `PRIVATE-ACCESS-${refreshes}`, expires_in: 3600 });
    }
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return Response.json({ id: 'google-user', email: 'agy@example.com' });
    assert.ok(['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'].includes(new URL(url).hostname));
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { project: 'project-one' });
    assert.match(init.headers.Authorization, /^Bearer PRIVATE-ACCESS-/);
    const result = await handler(url, init);
    return result instanceof Response ? result : Response.json(result);
  };
  return { calls, fetchImpl };
}

test('discovers personal T3 logins, deduplicates copies, and ignores other auth modes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(antigravityCredentials(f.t3StateDir), []);
  await f.profile();
  await f.profile('copy');
  await f.profile('enterprise', { ...token, refresh_token: 'enterprise' }, 'oauth-business');
  await f.profile('key', token, 'gemini-api-key');
  const malformed = await f.profile('malformed', '{invalid json');
  await f.profile('other', { ...token, refresh_token: 'another-login' });
  const credentials = antigravityCredentials(f.t3StateDir);
  assert.equal(credentials.length, 3);
  assert.equal(credentials.filter((c) => c.token).length, 2);
  assert.ok(credentials.some((c) => !c.token));
  await rm(malformed);
  assert.equal(antigravityCredentials(f.t3StateDir).length, 2);
});

test('summary parsing preserves model groups, unknown figures, and genuine reset times', () => {
  const windows = antigravitySummaryWindows({ groups: [
    { buckets: [bucket('gemini-5h'), bucket('3p-weekly', 0, 'weekly'), bucket('disabled', 0, 'weekly', { disabled: true })] },
    { displayName: 'Gemini 4 Argon', buckets: [bucket('gemini-argon-weekly', 0.95, 'weekly'),
      bucket('unknown', null, 'monthly'), bucket('string', '0.9'), bucket('nan', NaN), bucket('clamped', 2)] },
  ] }, NOW);
  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
  assert.equal(byId['gemini-5h'].usedPct, 25);
  assert.equal(byId['gemini-5h'].resetsAt, NOW + 3600_000);
  assert.equal(byId['3p-weekly'].label, 'Claude & GPT (shared) · Weekly');
  assert.equal(byId['3p-weekly'].windowSec, 604800);
  assert.equal(byId['3p-weekly'].usedPct, 100);
  assert.equal(byId['gemini-argon-weekly'].label, 'Gemini 4 Argon · Weekly');
  assert.equal(byId.clamped.usedPct, 0);
  for (const id of ['unknown', 'string', 'nan']) assert.equal(byId[id].usedPct, null);
  assert.equal(byId.unknown.windowSec, null);
  assert.equal(byId.unknown.resetUnknown, true);
  assert.ok(!byId.disabled);
  // `scope` is the family the label starts with: Antigravity has no account-wide window.
  assert.deepEqual(windows.map((w) => [w.id, w.scope]).sort(), [
    ['3p-weekly', 'Claude & GPT (shared)'], ['clamped', 'Gemini 4 Argon'], ['gemini-5h', 'Gemini'],
    ['gemini-argon-weekly', 'Gemini 4 Argon'], ['nan', 'Gemini 4 Argon'], ['string', 'Gemini 4 Argon'], ['unknown', 'Gemini 4 Argon'],
  ]);
  for (const w of windows) assert.equal(w.label.split(' · ')[0], w.scope);
  assert.equal(antigravitySummaryWindows({ buckets: [bucket('gemini-argon-weekly'), bucket('other-5h')] }, NOW).find((w) => w.id === 'gemini-argon-weekly').scope, 'Gemini Argon');
  assert.equal(antigravitySummaryWindows({ buckets: [bucket('other-5h')] }, NOW)[0].scope, 'other-5h');
  for (const input of [null, {}, { groups: [null, 1, { buckets: {} }] }]) assert.deepEqual(antigravitySummaryWindows(input), []);
  assert.doesNotThrow(() => antigravitySummaryWindows({ groups: [{ displayName: 42, buckets: [bucket('gemini-argon-5h')] }] }));
});

test('suppresses moving idle resets but preserves annotated, used and fixed resets', () => {
  const resetTime = new Date(NOW + 18000_000).toISOString();
  const idle = bucket('gemini-5h', 1, '5h', { resetTime });
  assert.equal(antigravitySummaryWindows({ buckets: [idle] }, NOW)[0].resetsAt, null);
  assert.equal(antigravitySummaryWindows({ buckets: [{ ...idle, description: 'Window in progress' }] }, NOW)[0].resetsAt, NOW + 18000_000);
  assert.equal(antigravitySummaryWindows({ buckets: [{ ...idle, remainingFraction: 0.5 }] }, NOW)[0].resetsAt, NOW + 18000_000);
  assert.equal(antigravitySummaryWindows({ buckets: [{ ...idle, resetTime: 'invalid' }] }, NOW)[0].resetsAt, null);
});

test('legacy quotas keep the most-used model per family without inventing a cadence', () => {
  const windows = antigravityModelWindows({ models: {
    'gemini-one': { quotaInfo: { remainingFraction: 0.9 } },
    'gemini-two': { quotaInfo: { remainingFraction: 0.5 }, weeklyQuotaInfo: { remainingFraction: 0.7 } },
    'claude-test': { quotaInfo: { remainingFraction: 0 } },
    unknown: { modelProvider: 'MODEL_PROVIDER_OPENAI', quotaInfo: { remainingFraction: 0.8 } },
    invalid: null,
  } });
  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
  assert.equal(byId['gemini-quota'].usedPct, 50);
  assert.equal(byId['gemini-quota'].windowSec, null);
  assert.equal(byId['gemini-quota'].resetUnknown, true);
  assert.equal(byId['gemini-weekly'].windowSec, 604800);
  assert.equal(byId['claude-quota'].usedPct, 100);
  assert.ok(byId['gpt-quota']);
  assert.deepEqual(windows.map((w) => [w.id, w.scope]).sort(), [
    ['claude-quota', 'Claude'], ['gemini-quota', 'Gemini'], ['gemini-weekly', 'Gemini'], ['gpt-quota', 'GPT'],
  ]);
  assert.deepEqual(antigravityModelWindows({ models: [] }), []);
});

test('merges Google endpoints conservatively and reuses renewed tokens without writing credentials', async (t) => {
  let clock = NOW;
  const f = await fixture(t);
  const file = await f.profile();
  await f.profile('copy');
  const original = await readFile(file, 'utf8');
  const { fetchImpl, calls } = upstream((url) => summary(bucket('gemini-5h', url.includes('daily-') ? 0.9 : 0.6),
    bucket('gemini-weekly', 0.8, 'weekly')));
  const collect = createAntigravityCollector({ ...f, fetchImpl, now: () => clock });
  const [account] = await collect();
  assert.equal(account.windows.find((w) => w.id === 'gemini-5h').usedPct, 40);
  assert.equal(account.email, 'agy@example.com');
  assert.equal(account.name, 'Antigravity');
  assert.equal(account.plan, null);
  assert.equal((await collect()).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 1);
  assert.equal(calls.filter((c) => c.url.includes('retrieveUserQuotaSummary')).length, 4);
  clock += 3540_000; // Refresh once the access token is within one minute of expiry.
  await collect();
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 2);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.ok(!calls.some((c) => c.url.includes('untrusted.example')));
  const output = JSON.stringify(account);
  for (const secret of [token.client_secret, token.refresh_token, 'PRIVATE-ACCESS']) assert.ok(!output.includes(secret));
});

test('an unavailable endpoint or optional profile lookup does not lose usable quotas', async (t) => {
  const f = await fixture(t); await f.profile();
  const { fetchImpl } = upstream((url) => url.includes('daily-') ? new Response('', { status: 503 }) : summary(bucket('gemini-5h')));
  const [account] = await createAntigravityCollector({ ...f, fetchImpl: (url, init) => url.endsWith('/userinfo')
    ? Promise.reject(new Error('Profile offline')) : fetchImpl(url, init) })();
  assert.equal(account.error, undefined);
  assert.equal(account.email, null);
  assert.equal(account.windows[0].usedPct, 25);
});

test('falls back to model quotas only when the summary has no usable figures', async (t) => {
  const f = await fixture(t); await f.profile();
  const { fetchImpl, calls } = upstream((url) => url.includes('retrieveUserQuotaSummary')
    ? summary(bucket('gemini-5h', null)) : { models: { 'gemini-pro': { quotaInfo: { remainingFraction: 0.4 } } } });
  const [account] = await createAntigravityCollector({ ...f, fetchImpl })();
  assert.equal(account.windows[0].usedPct, 60);
  assert.equal(account.windows[0].windowSec, null);
  assert.equal(calls.filter((c) => c.url.includes('fetchAvailableModels')).length, 2);
});

test('collection retains last-good readings on malformed quota responses, including after a restart', async (t) => {
  const f = await fixture(t); await f.profile();
  let clock = NOW; let failing = false;
  const { fetchImpl } = upstream(() => failing ? { groups: 'bad', models: null } : summary(bucket('gemini-5h')));
  const opts = { ...f, fetchImpl, now: () => clock };
  const getQuotas = createQuotaCollector(opts);
  const first = await getQuotas(true);
  failing = true; clock += 20_000;
  const second = await getQuotas(true);
  const restarted = await createQuotaCollector(opts)(true);
  for (const { accounts: [a] } of [second, restarted]) {
    assert.equal(a.stale, true);
    assert.equal(a.fetchedAt, NOW);
    assert.deepEqual(a.windows, first.accounts[0].windows);
    assert.match(a.error, /Could not read Antigravity quotas/);
  }
  const saved = await readFile(f.lastGoodFile, 'utf8');
  for (const secret of [token.client_secret, token.refresh_token, 'PRIVATE-ACCESS']) assert.ok(!saved.includes(secret));
});

test('revoked logins show a safe sign-in error and switching logins never revives the old quotas', async (t) => {
  const f = await fixture(t); const file = await f.profile();
  let clock = NOW; let revoked = false;
  const { fetchImpl } = upstream();
  const collect = createQuotaCollector({ ...f, now: () => clock, fetchImpl: (url, init) => revoked && url.endsWith('/token')
    ? Response.json({ error: 'invalid_grant', error_description: token.refresh_token }, { status: 400 }) : fetchImpl(url, init) });
  const first = (await collect(true)).accounts[0];
  await writeFile(file, JSON.stringify({ ...token, refresh_token: 'switched-login' }));
  revoked = true; clock += 20_000;
  const account = (await collect(true)).accounts[0];
  assert.notEqual(account.id, first.id);
  assert.equal(account.stale, undefined);
  assert.equal(account.windows, undefined);
  assert.match(account.error, /Sign in to Antigravity again in T3 Code/);
  assert.ok(!JSON.stringify(account).includes(token.refresh_token));
});

test('deadlines abort requests, redirects are rejected, and arbitrary errors never reach the browser', async (t) => {
  const f = await fixture(t); await f.profile();
  let aborted = false;
  const [timedOut] = await createAntigravityCollector({ ...f, requestTimeoutMs: 10, accountTimeoutMs: 50,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error(token.refresh_token)); }, { once: true });
    }) })();
  assert.ok(aborted);
  assert.match(timedOut.error, /Could not read Antigravity quotas/);
  assert.ok(!JSON.stringify(timedOut).includes(token.refresh_token));
  const [redirected] = await createAntigravityCollector({ ...f, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'error');
    throw new Error(`Redirect to https://example.com/?token=${token.refresh_token}`);
  } })();
  assert.equal(redirected.error, timedOut.error);
});

test('bad credential files yield a useful error without making requests', async (t) => {
  const f = await fixture(t); await f.profile('broken', '{invalid json');
  const [account] = await createAntigravityCollector({ ...f, fetchImpl: () => assert.fail('No requests expected') })();
  assert.match(account.error, /Could not read the saved Antigravity login/);
  assert.ok(!account.windows);
});
