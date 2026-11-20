import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboardServer } from '../server.mjs';
import { parseAllowedHosts } from '../hosts.mjs';
import { createPipelineSettings, SettingsInputError } from '../pipeline-settings.mjs';

const VIEW = (value = 12) => ({
  version: 1, day: '2026-11-20', plansToday: 3,
  settings: { maxPlansPerDay: { value, configValue: 12, overridden: value !== 12, min: 0, max: 48, describe: 'plans' } },
});

// A fake agentctl: records its arguments and answers like the real one.
function fakeRun(calls, { fail = false } = {}) {
  let value = 12;
  return async (file, args) => {
    calls.push([file, ...args]);
    if (fail) return null;
    if (args[0] === 'set') value = Number(args[2]);
    return JSON.stringify(VIEW(value));
  };
}

test('settings are read and changed through agentctl, with arguments only (no shell)', async () => {
  const calls = [];
  const s = createPipelineSettings({ run: fakeRun(calls), agentctl: '/bin/agentctl' });
  assert.equal((await s.get()).settings.maxPlansPerDay.value, 12);
  assert.equal((await s.set({ maxPlansPerDay: 6 })).settings.maxPlansPerDay.value, 6);
  assert.deepEqual(calls, [['/bin/agentctl', 'settings', '--json'], ['/bin/agentctl', 'set', 'maxPlansPerDay', '6']]);
});

test('bad values and unknown names never reach agentctl', async () => {
  const calls = [];
  const s = createPipelineSettings({ run: fakeRun(calls) });
  for (const body of [null, [], {}, { maxPlansPerDay: -1 }, { maxPlansPerDay: 49 }, { maxPlansPerDay: 2.5 }, { maxPlansPerDay: '6' },
    { maxWorkers: 3 }, { maxPlansPerDay: 6, maxWorkers: 3 }, { __proto__: { maxPlansPerDay: 6 } }]) {
    await assert.rejects(s.set(body), SettingsInputError, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test('an agentctl failure is an error, not a reading', async () => {
  const s = createPipelineSettings({ run: fakeRun([], { fail: true }) });
  await assert.rejects(s.get(), /agentctl settings failed/);
  await assert.rejects(s.set({ maxPlansPerDay: 6 }), /agentctl set maxPlansPerDay failed/);
});

async function start(t) {
  const calls = [];
  const logged = [];
  const none = async () => ({});
  const server = createDashboardServer({
    getQuotas: none, getWorkspaceStatus: none, getPipelineOverview: none,
    settings: createPipelineSettings({ run: fakeRun(calls) }),
    allowedHosts: parseAllowedHosts('dash.example.ts.net'), log: (...a) => logged.push(a),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  function request(method, { body, headers = {}, host = 'dash.example.ts.net:8443' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: '/api/pipeline/settings', headers: { Host: host, ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const ok = { Origin: 'https://dash.example.ts.net:8443', 'Content-Type': 'application/json' };
  return { request, calls, logged, ok };
}

test('GET reads the settings; POST from the page changes them', async (t) => {
  const { request, calls, ok } = await start(t);
  const read = await request('GET');
  assert.equal(read.status, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.body.settings.maxPlansPerDay.value, 12);
  const saved = await request('POST', { headers: ok, body: JSON.stringify({ maxPlansPerDay: 4 }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.maxPlansPerDay.value, 4);
  assert.deepEqual(calls.at(-1).slice(1), ['set', 'maxPlansPerDay', '4']);
});

test('writes from other sites, forms, other hosts or with bad bodies are refused before agentctl runs', async (t) => {
  const { request, calls, ok } = await start(t);
  const body = JSON.stringify({ maxPlansPerDay: 4 });
  const cases = [
    [403, { headers: { 'Content-Type': 'application/json' }, body }], // no Origin
    [403, { headers: { ...ok, Origin: 'https://evil.example' }, body }],
    [403, { headers: { ...ok, Origin: 'https://dash.example.ts.net.evil.example' }, body }],
    [403, { headers: { ...ok, Origin: 'null' }, body }],
    [415, { headers: { ...ok, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'maxPlansPerDay=4' }],
    [415, { headers: { ...ok, 'Content-Type': 'text/plain' }, body }],
    [400, { headers: ok, body: '{not json' }],
    [400, { headers: ok, body: JSON.stringify({ maxPlansPerDay: 400 }) }],
    [400, { headers: ok, body: JSON.stringify({ maxWorkers: 2 }) }],
    [413, { headers: ok, body: JSON.stringify({ maxPlansPerDay: 4, pad: 'x'.repeat(10_000) }) }],
    [403, { headers: ok, body, host: 'evil.example' }], // the Host check still comes first
  ];
  for (const [status, opts] of cases) {
    const res = await request('POST', opts);
    assert.equal(res.status, status, JSON.stringify({ ...opts, body: opts.body?.slice(0, 40) }));
  }
  assert.equal((await request('PUT', { headers: ok, body })).status, 405);
  assert.equal((await request('DELETE')).status, 405);
  assert.deepEqual(calls, []);
});
