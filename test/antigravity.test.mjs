import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityWindows, fetchAntigravity, findAntigravity, runAntigravity } from '../antigravity.mjs';
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
