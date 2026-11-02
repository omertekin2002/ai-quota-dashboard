import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  antigravityWindows, fetchAntigravity, findAntigravity, findT3Antigravity, parseAcpUsage, runAntigravity, runAntigravityAcp,
} from '../antigravity.mjs';
import { createQuotaCollector } from '../quotas.mjs';

// Synthetic, using the upstream CLI report schema linked in antigravity.mjs.
const report = (buckets, name = 'Gemini Models') => ({
  status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name, buckets }] } },
});
const weekly = { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.86, reset_time: '2026-11-09T12:00:00Z' };
const now = Date.parse('2026-11-02T12:00:00Z');

function fixture(t, source = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(home, 'agy');
  fs.writeFileSync(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { home, binary, environment: { PATH: '', ANTIGRAVITY_CLI_PATH: binary } };
}

test('parses shared family quotas and separate model allowances with explicit cadences', () => {
  const data = report([weekly, { id: 'gemini-5h', window: '5h', remaining_fraction: 0.95 }]);
  data.command.data.groups.push(
    { name: 'Claude and GPT models', buckets: [{ ...weekly, id: '3p-weekly', remaining_fraction: 0 }] },
    { name: 'Gemini 4 Argon', buckets: [{ ...weekly, id: 'argon-weekly', remaining_fraction: 0.53 }] },
  );
  const windows = antigravityWindows(data);
  assert.deepEqual(windows.map((w) => [w.label, w.usedPct, w.windowSec]), [
    ['Gemini Models · Weekly', 14, 604800], ['Gemini Models · 5-hour', 5, 18000],
    ['Claude and GPT models · Weekly', 100, 604800], ['Gemini 4 Argon · Weekly', 47, 604800],
  ]);
  assert.equal(windows[0].resetsAt, Date.parse(weekly.reset_time));
  assert.equal(windows[1].resetsAt, null);
  assert.equal(new Set(windows.map((w) => w.id)).size, 4);
  assert.equal(antigravityWindows(report([weekly, { id: 'x', window: 'future', name: 'New allowance', remaining_fraction: 1 }]))[1].windowSec, null);
  const reversed = structuredClone(data);
  reversed.command.data.groups.reverse();
  assert.deepEqual(antigravityWindows(reversed).map((w) => w.id).sort(), windows.map((w) => w.id).sort());
});

test('unknown, out-of-range and disabled quotas never imply unused or exhausted allowances', () => {
  for (const value of [undefined, null, '', '0.4', true, {}, NaN, Infinity, -0.1, 1.1]) {
    assert.equal(antigravityWindows(report([{ ...weekly, remaining_fraction: value }]))[0].usedPct, null);
  }
  const [disabled] = antigravityWindows(report([{ ...weekly, disabled: true, reset_time: 'invalid' }]));
  assert.equal(disabled.usedPct, null);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.resetsAt, null);
  const [known] = antigravityWindows(report([{ id: 'w', window: 'weekly', remaining: { case: 'remainingFraction', value: 1 } }]));
  assert.equal(known.usedPct, 0);
});

test('rejects unrelated commands, failed status, empty groups and malformed buckets', () => {
  for (const input of [null, {}, { ...report([weekly]), status: 'ERROR' },
    { status: 'SUCCESS', command: { name: 'models', data: { groups: [] } } },
    report([]), report([null]), report([weekly, weekly]), report([{ remaining_fraction: 1 }])]) {
    assert.throws(() => antigravityWindows(input));
  }
});

test('discovers executable paths without a shell and honors explicit missing overrides', (t) => {
  const opts = fixture(t);
  assert.equal(findAntigravity(opts), opts.binary);
  assert.equal(findAntigravity({ ...opts, environment: { PATH: opts.home } }), opts.binary);
  assert.equal(findAntigravity({ ...opts, environment: { PATH: opts.home, ANTIGRAVITY_CLI_PATH: '/not-present/agy' } }), null);
  assert.equal(findAntigravity({ ...opts, environment: { PATH: opts.home, ANTIGRAVITY_CLI_PATH: '' } }), null);
  fs.chmodSync(opts.binary, 0o600);
  assert.equal(findAntigravity(opts), null);
});

test('missing CLI is omitted unless configured or previously seen', async (t) => {
  const { home } = fixture(t);
  assert.deepEqual(await fetchAntigravity({ home, environment: { PATH: '' } }), []);
  for (const extra of [{ previouslySeen: true }, { environment: { PATH: '', ANTIGRAVITY_CLI_PATH: '/missing/agy' } }]) {
    const [account] = await fetchAntigravity({ home, environment: { PATH: '' }, ...extra });
    assert.match(account.error, /CLI not found/);
    assert.equal(account.windows, undefined);
  }
});

test('real subprocess runs only version and usage, blocks browser launching, disables updates and removes temp files', async (t) => {
  const opts = fixture(t, `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.HOME + '/calls', JSON.stringify({ args, cwd: process.cwd(), update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE }) + '\\n');
    if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') process.exit(7);
    if (args[0] === '--version') { console.log('1.2.2'); process.exit(0); }
    if (JSON.stringify(args) !== JSON.stringify(['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'])) process.exit(8);
    for (const name of ['open', 'xdg-open', process.env.BROWSER]) {
      if (spawnSync(name, ['https://example.invalid'], { env: process.env }).status !== 1) process.exit(9);
    }
    console.log(${JSON.stringify(JSON.stringify(report([weekly])))});
  `);
  const [account] = await fetchAntigravity(opts);
  assert.equal(account.error, undefined);
  assert.equal(account.windows[0].usedPct, 14);
  assert.equal(account.email, null); // the report cannot prove identity or plan
  const calls = fs.readFileSync(path.join(opts.home, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.notEqual(call.cwd, opts.home);
    assert.equal(call.update, 'true');
    assert.equal(fs.existsSync(call.cwd), false);
  }
});

test('old or unknown versions cannot turn /usage into a model prompt', async (t) => {
  const opts = fixture(t);
  for (const version of ['1.1.10', '0.99.0', '', '1.2.2-preview', 'garbage']) {
    let calls = 0;
    const [account] = await fetchAntigravity({ ...opts, run: async (_, args) => { calls++; assert.deepEqual(args, ['--version']); return version; } });
    assert.match(account.error, /1.1.11/);
    assert.equal(calls, 1);
  }
});

test('failed command output is never published, and invalid JSON is reported safely', async (t) => {
  const opts = fixture(t, `console.error('OAuth private-secret https://example.invalid/token'); process.exit(1);`);
  const [account] = await fetchAntigravity(opts);
  assert.match(account.error, /sign-in/);
  assert.ok(!JSON.stringify(account).includes('private-secret'));
  const [invalid] = await fetchAntigravity({ ...opts, run: async (_, args) => args[0] === '--version' ? '1.2.2' : 'private-secret invalid JSON' });
  assert.match(invalid.error, /no valid quota report/);
  assert.ok(!JSON.stringify(invalid).includes('private-secret'));
});

test('runner bounds time and output and kills its language-server child', async (t) => {
  const opts = fixture(t);
  const options = { cwd: opts.home, env: process.env, timeoutMs: 1500 };
  await assert.rejects(runAntigravity(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], { ...options, maxBytes: 1024 }), { code: 'OUTPUT' });
  await assert.rejects(runAntigravity(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync('child-pid', String(child.pid));
    setInterval(() => {}, 1000);
  `], options), { code: 'TIMEOUT' });
  const pid = Number(fs.readFileSync(path.join(opts.home, 'child-pid'), 'utf8'));
  // A reparented dead process can remain a zombie until init reaps it.
  if (process.platform === 'linux' && fs.existsSync(`/proc/${pid}/stat`)) {
    assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), /\) Z /);
  } else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('collector caches agy, retains private last-good readings on failure/restart and isolates other providers', async (t) => {
  const opts = fixture(t);
  let clock = now, calls = 0, broken = false;
  const runAgy = async (_, args) => {
    calls++;
    if (broken) throw new Error('private-secret');
    return args[0] === '--version' ? '1.1.11' : JSON.stringify(report([weekly]));
  };
  const lastGoodFile = path.join(opts.home, 'last-good.json');
  const settings = { ...opts, lastGoodFile, runAgy, now: () => clock };
  const get = createQuotaCollector(settings);
  const [first] = (await get()).accounts;
  assert.equal(first.windows[0].usedPct, 14);
  assert.equal(calls, 2);
  await get(); await get(true);
  assert.equal(calls, 2);
  clock += 16_000;
  broken = true;
  const [stale] = (await get(true)).accounts;
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, now);
  assert.deepEqual(stale.windows, first.windows);
  const [restarted] = (await createQuotaCollector(settings)(true)).accounts;
  assert.equal(restarted.stale, true);
  fs.unlinkSync(opts.binary);
  const [missing] = (await createQuotaCollector({ ...settings, environment: { PATH: '' } })(true)).accounts;
  assert.equal(missing.stale, true);
  assert.match(missing.error, /CLI not found/);
  const saved = fs.readFileSync(lastGoodFile, 'utf8');
  assert.ok(!saved.includes('private-secret') && !saved.includes(opts.binary));
  assert.equal(fs.statSync(lastGoodFile).mode & 0o777, 0o600);
  // An agy launch failure doesn't hide another provider's reading.
  fs.mkdirSync(path.join(opts.home, '.codex'));
  fs.writeFileSync(path.join(opts.home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'test', account_id: 'acct' } }));
  const mixed = await createQuotaCollector({ ...settings, fetchImpl: async () => Response.json({ rate_limit: { primary_window: { used_percent: 20 } } }) })(true);
  assert.deepEqual(mixed.accounts.map((a) => a.provider), ['openai', 'antigravity']);
  assert.equal(mixed.accounts[0].windows[0].usedPct, 20);
});

// ---------- T3 Code's agy ACP runtime ----------

// The Markdown agy_acp_server 1.4.1 sends for `/usage` (real layout, synthetic numbers).
const ACP_USAGE = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini Flash, Gemini Pro)*
  - **Weekly Limit Remaining:** 98% remaining (resets Nov 03, 2026, 14:20 UTC)
  - **Five Hour Limit Remaining:** 64% remaining (resets Nov 02, 2026, 23:59 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Opus, Claude Sonnet, GPT-OSS)*
  - **Weekly Limit Remaining:** 0% remaining (resets Nov 03, 2026, 13:58 UTC)
- **Gemini 4 Argon**
  *(For paid Pro plans, Argon quota is separate.)*
  - **Gemini 4 Argon Weekly Limit:** 100% remaining (resets Nov 09, 2026, 20:43 UTC)`;

test('parses the ACP /usage Markdown into the same windows as the CLI report', () => {
  const windows = antigravityWindows(parseAcpUsage(ACP_USAGE));
  assert.deepEqual(windows.map((w) => [w.label, w.usedPct, w.windowSec, w.resetsAt]), [
    ['Gemini Models · Weekly', 2, 604800, Date.parse('2026-11-03T14:20:00Z')],
    ['Gemini Models · 5-hour', 36, 18000, Date.parse('2026-11-02T23:59:00Z')],
    ['Claude and GPT models · Weekly', 100, 604800, Date.parse('2026-11-03T13:58:00Z')],
    ['Gemini 4 Argon · Weekly', 0, 604800, Date.parse('2026-11-09T20:43:00Z')],
  ]);
  const odd = antigravityWindows(parseAcpUsage(`### Quota Limits
- **Models**
  - **Daily Requests:** 1,000 units remaining
  - **Weekly Limit Remaining:** Available (resets 2026-11-09T12:00:00Z)
  - **Five Hour Limit Remaining:** Disabled: Not on this plan
- **Empty**
  - No active bucket limits`));
  assert.deepEqual(odd.map((w) => [w.label, w.usedPct, w.windowSec, w.disabled]), [
    ['Models · Daily Requests', null, null, false], ['Models · Weekly', null, 604800, false], ['Models · 5-hour', null, 18000, true],
  ]);
  assert.equal(odd[1].resetsAt, Date.parse('2026-11-09T12:00:00Z'));
});

test('ACP /usage failures map to specific errors, and malformed replies are rejected', () => {
  const limits = (line) => `### Session Usage\n- x\n\n### Quota Limits\n${line}`;
  for (const [line, code] of [
    ['- Unable to retrieve quota status (HTTP 403 private-secret)', 'QUOTA'],
    ['- Not applicable for current authentication method.', 'METHOD'],
    ['- data not available yet', 'AUTH'],
  ]) assert.throws(() => parseAcpUsage(limits(line)), { code });
  for (const input of [undefined, '', 'no section', limits('- No quota limits reported.'), limits('  - **Weekly:** 5% remaining')]) {
    assert.throws(() => antigravityWindows(parseAcpUsage(input)), { code: 'REPORT' });
  }
});

// A fake agy_acp_server: logs how it was launched, simulates a token refresh by atomic replace, refuses
// nothing itself but asks the client for a permission (which must be refused) before ending the turn.
const FAKE_ACP = `
  const fs = require('node:fs'), path = require('node:path');
  const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\\n');
  const state = path.join(process.env.GEMINI_HOME, 'antigravity-acp');
  const token = path.join(state, 'acp_token.json');
  log({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.GEMINI_HOME, harness: process.env.ANTIGRAVITY_HARNESS_PATH,
    storage: process.env.AGY_ACP_FORCE_FILE_STORAGE, link: fs.lstatSync(token).isSymbolicLink(), token: fs.readFileSync(token, 'utf8'),
    settings: fs.readFileSync(path.join(state, 'settings.json'), 'utf8') });
  const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const chunk = (sessionId, text) => out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  let prompt;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === 'session/new') {
      if (process.env.FAKE_MODE === 'auth') return out({ id: m.id, error: { code: -32000, message: 'Authentication required private-secret' } });
      fs.writeFileSync(token + '.tmp', 'refreshed');
      fs.renameSync(token + '.tmp', token);
      out({ id: m.id, result: { sessionId: 's1' } });
    } else if (m.method === 'session/prompt') {
      if (process.env.FAKE_MODE === 'hang') return;
      log({ prompt: m.params.prompt });
      prompt = m.id;
      chunk('other-session', 'ignored');
      const text = process.env.FAKE_REPLY;
      chunk('s1', text.slice(0, 40));
      chunk('s1', text.slice(40));
      out({ id: 'ask', method: 'session/request_permission', params: {} });
    } else if (m.id === 'ask') {
      log({ refused: m.error && m.error.code });
      out({ id: prompt, result: { stopReason: 'end_turn' } });
    }
  });
`;

function t3Fixture(t, { mode = 'ok', reply = ACP_USAGE } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-agy-t3-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tools = path.join(home, '.t3/tools/antigravity-acp', `${process.platform}-${process.arch}`);
  const dir = path.join(tools, 'versions', 'rel-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(tools, 'active.json'), JSON.stringify({ releaseId: 'rel-1' }));
  const server = path.join(dir, 'agy_acp_server.par');
  fs.writeFileSync(server, `#!${process.execPath}\n${FAKE_ACP}`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'localharness_external'), '#!/bin/sh\n', { mode: 0o700 });
  const instance = (name, mtime) => {
    const state = path.join(home, '.t3/userdata/providers/antigravity', name, 'antigravity-acp');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'settings.json'), '{"auth":{"type":"oauth-personal"}}');
    fs.writeFileSync(path.join(state, 'acp_token.json'), `secret-token-${name}`, { mode: 0o600 });
    fs.utimesSync(path.join(state, 'acp_token.json'), mtime, mtime);
    return path.dirname(state);
  };
  const old = instance('old', new Date('2026-01-01'));
  const current = instance('current', new Date('2026-11-01'));
  const log = path.join(home, 'calls');
  return { home, server, old, current, log, environment: { PATH: '', FAKE_LOG: log, FAKE_MODE: mode, FAKE_REPLY: reply } };
}
const calls = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

test('finds T3 Code’s active agy runtime and its most recently signed-in provider instance', (t) => {
  const opts = t3Fixture(t);
  const found = findT3Antigravity(opts);
  assert.equal(found.server, opts.server);
  assert.equal(found.harness, path.join(path.dirname(opts.server), 'localharness_external'));
  assert.equal(found.geminiHome, opts.current);
  assert.equal(findT3Antigravity({ home: os.tmpdir(), environment: { T3CODE_HOME: path.join(opts.home, '.t3') } }).server, opts.server);
  assert.equal(findT3Antigravity({ ...opts, environment: { T3CODE_HOME: 'relative/.t3' } }), null);
  fs.rmSync(path.join(opts.current, 'antigravity-acp/acp_token.json'));
  assert.equal(findT3Antigravity(opts).geminiHome, opts.old);
  fs.rmSync(path.join(opts.old, 'antigravity-acp/acp_token.json'));
  assert.equal(findT3Antigravity(opts).geminiHome, null);
  const active = path.join(path.dirname(path.dirname(path.dirname(opts.server))), 'active.json');
  fs.writeFileSync(active, JSON.stringify({ releaseId: '..' }));
  assert.equal(findT3Antigravity(opts), null);
  fs.writeFileSync(active, JSON.stringify({ releaseId: 'rel-1' }));
  fs.chmodSync(path.join(path.dirname(opts.server), 'localharness_external'), 0o600);
  assert.equal(findT3Antigravity(opts), null);
});

test('T3 runtime: sends only /usage over ACP from a throwaway Gemini home and never writes T3 Code’s files', async (t) => {
  const opts = t3Fixture(t);
  const [account] = await fetchAntigravity(opts);
  assert.equal(account.error, undefined);
  assert.deepEqual(account.sources, ['T3 Code agy runtime']);
  assert.equal(account.windows.length, 4);
  assert.equal(account.windows[0].usedPct, 2);
  assert.equal(account.limitReached, true);
  const [launch, prompt, refused] = calls(opts.log);
  assert.deepEqual(launch.args, ['--uid=']);
  assert.equal(launch.link, true);
  assert.equal(launch.token, 'secret-token-current');
  assert.equal(launch.settings, '{"auth":{"type":"oauth-personal"}}');
  assert.equal(launch.storage, '1');
  assert.equal(launch.harness, path.join(path.dirname(opts.server), 'localharness_external'));
  for (const dir of [launch.cwd, launch.home]) {
    assert.ok(!dir.startsWith(opts.home), dir);
    assert.equal(fs.existsSync(dir), false);
  }
  assert.deepEqual(prompt.prompt, [{ type: 'text', text: '/usage' }]);
  assert.equal(refused.refused, -32601);
  // The simulated refresh replaced only the temporary link.
  assert.equal(fs.readFileSync(path.join(opts.current, 'antigravity-acp/acp_token.json'), 'utf8'), 'secret-token-current');
  assert.deepEqual(fs.readdirSync(path.join(opts.current, 'antigravity-acp')).sort(), ['acp_token.json', 'settings.json']);
  assert.ok(!JSON.stringify(account).includes('secret-token') && !JSON.stringify(account).includes(opts.home));
});

test('T3 runtime: sign-in and quota failures are reported without leaking server output', async (t) => {
  const [auth] = await fetchAntigravity(t3Fixture(t, { mode: 'auth' }));
  assert.match(auth.error, /Sign in to Antigravity in T3 Code/);
  assert.ok(!JSON.stringify(auth).includes('private-secret'));
  const [quota] = await fetchAntigravity(t3Fixture(t, { reply: '### Quota Limits\n- Unable to retrieve quota status (private-secret)' }));
  assert.match(quota.error, /could not retrieve quota status/);
  assert.ok(!JSON.stringify(quota).includes('private-secret'));
  const [method] = await fetchAntigravity(t3Fixture(t, { reply: '### Quota Limits\n- Not applicable for current authentication method.' }));
  assert.match(method.error, /only for Google account sign-ins/);
  const [garbage] = await fetchAntigravity(t3Fixture(t, { reply: 'private-secret' }));
  assert.match(garbage.error, /no valid quota report/);
});

test('T3 runtime without a login is omitted unless previously seen; the standalone CLI takes precedence', async (t) => {
  const opts = t3Fixture(t);
  for (const instance of [opts.old, opts.current]) fs.rmSync(path.join(instance, 'antigravity-acp/acp_token.json'));
  let acpCalls = 0;
  const runAcp = async () => { acpCalls++; return ACP_USAGE; };
  assert.deepEqual(await fetchAntigravity({ ...opts, runAcp }), []);
  const [seen] = await fetchAntigravity({ ...opts, runAcp, previouslySeen: true });
  assert.match(seen.error, /Sign in to Antigravity in T3 Code/);
  assert.equal(acpCalls, 0);
  const cli = fixture(t, `console.log(process.argv[2] === '--version' ? '1.2.2' : ${JSON.stringify(JSON.stringify(report([weekly])))})`);
  const [account] = await fetchAntigravity({ ...cli, home: opts.home, runAcp });
  assert.deepEqual(account.sources, ['agy CLI']);
  assert.equal(account.windows[0].usedPct, 14);
  assert.equal(acpCalls, 0);
});

test('ACP runner times out a stalled turn and cleans up', async (t) => {
  const opts = t3Fixture(t, { mode: 'hang' });
  const env = { ...process.env, ...opts.environment, GEMINI_HOME: opts.current };
  await assert.rejects(runAntigravityAcp(opts.server, { cwd: opts.home, env, timeoutMs: 1500 }), { code: 'TIMEOUT' });
  await assert.rejects(runAntigravityAcp(path.join(opts.home, 'missing'), { cwd: opts.home, env, timeoutMs: 1500 }), { code: 'LAUNCH' });
});
