import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkHttp, createDiagnostics, parsePressure, systemdTime } from '../diagnostics.mjs';
import { createWorkspaceHistory, memoryLevel } from '../workspace-history.mjs';

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  return root;
}

test('HTTP 200 requires the expected health payload; redirects, errors, and timeouts fail', async () => {
  const check = { id: 'proxy', service: 'proxy.service', label: 'Proxy', url: 'http://127.0.0.1/health', kind: 'proxy' };
  assert.equal((await checkHttp(check, async () => Response.json({ ok: true }))).state, 'healthy');
  for (const response of [new Response('<html>ngrok warning</html>'), Response.json({ ok: false }), new Response('', { status: 302 }), Response.json({ ok: true }, { status: 503 })]) {
    assert.equal((await checkHttp(check, async () => response)).state, 'unhealthy');
  }
  const timeout = await checkHttp(check, async () => { throw new DOMException('timeout', 'TimeoutError'); });
  assert.equal(timeout.detail, 'Timed out');
  assert.equal((await checkHttp({ ...check, kind: 't3' }, async () => new Response('<title>T3 Code (Beta)</title>'))).state, 'healthy');
  assert.equal((await checkHttp({ ...check, kind: 't3' }, async () => new Response('<title>Different app</title>'))).state, 'unhealthy');
});

test('public ngrok probes are cached for 15 minutes and never follow arbitrary agent URLs', async (t) => {
  const procRoot = await fixture(t);
  let time = 1_000_000, publicRequests = 0, tunnel = 'https://test.ngrok-free.dev';
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/tunnels')) return Response.json({ tunnels: [{ public_url: tunnel, config: { addr: 'http://localhost:8330' } }] });
    if (url.startsWith('https://test.ngrok-free.dev')) publicRequests++;
    if (url.includes('3773') || url === 'https://hp-laptop.tailf900b6.ts.net/') return new Response('<title>T3 Code (Beta)</title>');
    return Response.json(url.includes('8317') ? { status: 'ok' } : { ok: true });
  };
  const collect = createDiagnostics({ procRoot, run: async () => null, fetchImpl, now: () => time });
  await collect(); await collect();
  assert.equal(publicRequests, 1);
  time += 15 * 60_000;
  await collect();
  assert.equal(publicRequests, 2);
  tunnel = 'https://127.0.0.1/private';
  const result = await collect();
  assert.equal(result.healthChecks.find((c) => c.id === 'ngrok-public').state, 'unknown');
  assert.equal(publicRequests, 2);
});

test('autofs alone is not a mounted T7 and never triggers a space query against it', async (t) => {
  const procRoot = await fixture(t, {
    'self/mountinfo': '1 0 8:2 / / rw - ext4 /dev/nvme0 rw\n2 1 0:1 / /mnt/nas rw - autofs systemd-1 rw\n',
  });
  const queried = [];
  const result = await createDiagnostics({ procRoot, fetchImpl: async () => new Response('', { status: 503 }), run: async (file, args) => {
    if (file === 'df') { queried.push(args.at(-1)); return '1B-blocks Used Available Use%\n1000 200 750 22%\n'; }
    return null;
  } })();
  assert.deepEqual(queried, ['/']);
  assert.equal(result.disks[0].freeBytes, 750);
  assert.equal(result.disks[1].mounted, false);
  assert.equal(result.disks[1].usedPct, null);
});

test('real read-only T7 mount, backup timing, PSI, top memory consumers, and route types are reported', async (t) => {
  const procRoot = await fixture(t, {
    'self/mountinfo': '1 0 8:2 / / rw - ext4 /dev/nvme0 rw\n2 1 0:1 / /mnt/nas rw - autofs systemd-1 rw\n3 2 8:1 / /mnt/nas ro - exfat /dev/sda1 ro\n',
    'pressure/memory': 'some avg10=12.50 avg60=2.00 avg300=1.00 total=123\nfull avg10=2.00 avg60=0.50 avg300=0.10 total=3\n',
    vmstat: 'oom_kill 2\n',
  });
  const run = async (file) => {
    if (file === 'df') return '1B-blocks Used Available Use%\n1000 900 100 90%\n';
    if (file === 'ps') return ' 45 200000 node-MainThread\n 46 30000 codex\n';
    if (file === 'tailscale') return JSON.stringify({ BackendState: 'Running', Peer: { a: { Active: true, Online: true, CurAddr: 'redacted', Relay: 'fra' }, b: { Active: true, Online: true, Relay: 'fra' }, c: { Active: false, Online: true, CurAddr: 'redacted' } } });
    if (file === 'systemctl') return 'Id=t7-backup.service\nLoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=Sun 2026-10-25 03:10:28 +03\n\nId=t7-backup.timer\nLoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Mon 2026-10-26 03:09:34 +03\n';
    return null;
  };
  const result = await createDiagnostics({ procRoot, run, fetchImpl: async () => new Response('', { status: 503 }) })();
  assert.equal(result.disks[1].mounted, true);
  assert.equal(result.disks[1].readOnly, true);
  assert.equal(result.pressure.memory.some.avg10, 12.5);
  assert.equal(result.topProcesses[0].rssBytes, 200000 * 1024);
  assert.equal(result.oomKills, 2);
  assert.equal(result.backup.lastSuccessAt, Date.parse('2026-10-25T00:10:28Z'));
  assert.equal(result.backup.nextRunAt, Date.parse('2026-10-26T00:09:34Z'));
  assert.deepEqual(result.tailscale.connections, [{ type: 'direct', count: 1 }, { type: 'relay', count: 1 }]);
  assert.ok(!JSON.stringify(result.tailscale).includes('redacted'));
});

test('a service with default success status but no completed run is not a successful backup', async (t) => {
  const procRoot = await fixture(t);
  const result = await createDiagnostics({ procRoot, fetchImpl: async () => new Response('', { status: 503 }), run: async (file) => file === 'systemctl' ? 'Id=t7-backup.service\nLoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\n' : null })();
  assert.equal(result.backup.state, 'never-run');
  assert.equal(result.backup.lastSuccessAt, null);
  assert.equal(parsePressure('not a reading'), null);
  assert.equal(systemdTime('n/a'), null);
  const active = await createDiagnostics({ procRoot, fetchImpl: async () => new Response('', { status: 503 }), run: async (file) => file === 'systemctl' ? 'Id=t7-backup.service\nLoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=Sun 2026-10-25 03:10:28 +03\n' : null })();
  assert.equal(active.backup.state, 'running');
  assert.equal(active.backup.lastSuccessAt, null);
});

function snapshot(now) {
  return { generatedAt: now, uptimeSec: 1000, memory: { usedPct: 50 }, internet: { state: 'online', networkName: 'Wi-Fi', latencyMs: 50, disconnections: 1 },
    services: [{ unit: 't3code.service', name: 'T3 Code', state: 'running', automaticRestarts: 0, startedAt: 100 }],
    diagnostics: { pressure: { memory: { some: { avg10: 0 }, full: { avg10: 0 } } }, oomKills: 0,
      healthChecks: [{ id: 't3-local', label: 'Local web', state: 'healthy' }], disks: [{ name: 'T7 drive', path: '/mnt/nas', mounted: true, readOnly: false, usedPct: 25 }],
      backup: { state: 'success', finishedAt: now - 1000, lastSuccessAt: now - 1000 } } };
}

test('history survives dashboard restarts, detects failures between readings, and preserves backup success', async (t) => {
  const root = await fixture(t), file = path.join(root, 'history.json');
  const first = snapshot(1_000_000);
  await createWorkspaceHistory({ file })(first);
  const next = structuredClone(first);
  next.generatedAt += 30_000;
  next.internet.disconnections++;
  next.services[0].startedAt++;
  next.diagnostics.oomKills++;
  next.diagnostics.pressure.memory.full.avg10 = 12;
  next.diagnostics.backup = { state: 'failed', finishedAt: next.generatedAt, lastSuccessAt: null };
  const result = await createWorkspaceHistory({ file })(next);
  assert.equal(result.persisted, true);
  assert.equal(result.lastSuccessAt, first.diagnostics.backup.lastSuccessAt);
  for (const text of ['link dropped', 'T3 Code restarted', 'memory ran out', 'Memory pressure', 'backup failed']) assert.ok(result.events.some((e) => e.title.includes(text)), text);
  assert.equal(result.events.filter((e) => e.title === 'Computer monitoring started').length, 1);
  assert.equal(result.samples.length, 2);
  assert.equal(memoryLevel(next), 'critical');
});

test('latency samples expire, refreshes do not add duplicate samples, and unwritable history is visible', async (t) => {
  const root = await fixture(t), record = createWorkspaceHistory({ file: root });
  const value = snapshot(10_000_000);
  assert.equal((await record(value)).persisted, false);
  value.generatedAt += 5000;
  assert.equal((await record(value)).samples.length, 1);
  value.generatedAt += 31 * 60_000;
  assert.equal((await record(value)).samples.length, 1);
});
