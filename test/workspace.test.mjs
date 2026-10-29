import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, createWorkspaceMonitor, probeInternet } from '../workspace.mjs';

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${value}\n`);
  }
  return {
    sysRoot: path.join(root, 'sys'), procRoot: path.join(root, 'proc'), platform: 'linux',
    workflowHome: path.join(root, 'workflow'), repoRoot: path.join(root, 'repo'), t3Worktrees: path.join(root, 't3'),
    run: async () => null, probe: async () => ({ reachable: false, latencyMs: null }),
    fetchImpl: async () => new Response('{}', { status: 503 }),
  };
}

test('reads battery, AC, hottest CPU sensor, and memory available for actual work', async (t) => {
  const monitor = createWorkspaceMonitor(await fixture(t, {
    'sys/class/power_supply/BAT1/type': 'Battery',
    'sys/class/power_supply/BAT1/capacity': '73',
    'sys/class/power_supply/BAT1/status': 'Charging',
    'sys/class/power_supply/ACAD/type': 'Mains',
    'sys/class/power_supply/ACAD/online': '1',
    'sys/class/hwmon/hwmon4/name': 'k10temp',
    'sys/class/hwmon/hwmon4/temp1_input': '52125',
    'sys/class/hwmon/hwmon4/temp2_input': '61000',
    'sys/class/hwmon/hwmon4/temp2_crit': '95000',
    'sys/class/hwmon/hwmon4/temp3_input': 'not a sensor reading',
    'sys/class/hwmon/hwmon7/name': 'nvme',
    'sys/class/hwmon/hwmon7/temp1_input': '33850',
    'sys/class/dmi/id/product_name': 'HP test laptop',
    'proc/meminfo': 'MemTotal:       8000 kB\nMemFree:        1000 kB\nMemAvailable:   3000 kB\nSwapTotal:      2000 kB\nSwapFree:       1500 kB',
    'proc/uptime': '12345.67 100000',
  }));
  const result = await monitor();
  assert.equal(result.model, 'HP test laptop');
  assert.equal(result.uptimeSec, 12345.67);
  assert.equal(result.power.acOnline, true);
  assert.deepEqual(result.power.batteries, [{ name: 'BAT1', percent: 73, status: 'Charging' }]);
  assert.deepEqual(result.temperatures.map((s) => [s.name, s.celsius]), [['CPU', 61], ['SSD', 33.85]]);
  assert.equal(result.temperatures[0].criticalCelsius, 95);
  assert.equal(result.memory.usedBytes, 5000 * 1024);
  assert.equal(result.memory.usedPct, 62.5);
  assert.equal(result.memory.swapUsedBytes, 500 * 1024);
});

test('missing hardware and unavailable commands stay unknown rather than healthy or zero', async (t) => {
  const result = await createWorkspaceMonitor(await fixture(t))();
  assert.deepEqual(result.power, { acOnline: null, batteries: [] });
  assert.deepEqual(result.temperatures, []);
  assert.equal(result.memory, null);
  assert.equal(result.internet.state, 'unknown');
  assert.equal(result.internet.networkName, null);
  assert.ok(result.services.every((s) => s.state === 'unknown'));
});

test('reports stopped, failed, missing, and starting services distinctly from running', async (t) => {
  const options = await fixture(t);
  const states = {
    'sh.brew.cliproxyapi.service': ['loaded', 'active', 'running'],
    'ngrok-proxy-llm.service': ['loaded', 'failed', 'failed'],
    't3code.service': ['loaded', 'inactive', 'dead'],
    'tailscaled.service': ['not-found', 'inactive', 'dead'],
    'net-watchdog.service': ['loaded', 'activating', 'start'],
  };
  options.run = async (file, args) => file === 'systemctl' ? args.filter((a) => a.endsWith('.service')).map((unit) => {
    const [load, active, sub] = states[unit] || ['not-found', 'inactive', 'dead'];
    return `Id=${unit}\nLoadState=${load}\nActiveState=${active}\nSubState=${sub}`;
  }).join('\n\n') : null;
  const result = await createWorkspaceMonitor(options)();
  assert.deepEqual(result.services.map((s) => s.state), ['running', 'failed', 'stopped', 'not-found', 'activating']);
});

test('failed HTTPS checks never claim internet is online from a network link alone', async (t) => {
  const options = await fixture(t);
  for (const [connectivity, expected] of [['full', 'limited'], ['limited', 'limited'], ['portal', 'portal'], ['none', 'offline'], ['unknown', 'unknown']]) {
    const result = await createWorkspaceMonitor({ ...options, run: async (file) => file === 'nmcli' ? `${connectivity}\n` : null })();
    assert.equal(result.internet.state, expected);
  }
  const result = await createWorkspaceMonitor({ ...options, probe: async () => ({ reachable: true, latencyMs: 42 }) })();
  assert.equal(result.internet.state, 'online');
  assert.equal(result.internet.latencyMs, 42);
});

test('shows the associated Wi-Fi SSID, preserving punctuation and ignoring virtual adapters', async (t) => {
  const options = await fixture(t);
  options.run = async (file, args) => {
    if (file !== 'nmcli') return null;
    if (args.includes('CONNECTIVITY')) return 'full\n';
    if (args.includes('TYPE,STATE,DEVICE,CONNECTION')) return 'tun:connected (externally):tailscale0:tailscale0\nbridge:connected (externally):docker0:docker0\nwifi:connected:wlo1:Saved profile\n';
    if (args.includes('ACTIVE,SIGNAL,RATE,SSID')) return 'no:20:100 Mbit/s:Guest\nyes:54:1170 Mbit/s:Studio:West\\WiFi\n';
    return null;
  };
  const result = await createWorkspaceMonitor(options)();
  assert.equal(result.internet.networkName, 'Studio:West\\WiFi');
  assert.equal(result.internet.networkType, 'wifi');
  assert.equal(result.internet.signalPct, 54);
  assert.equal(result.internet.linkRate, '1170 Mbit/s');
});

test('shows wired connection names and clears the network name after disconnecting', async (t) => {
  const options = await fixture(t);
  let devices = 'ethernet:connected:eno1:Office LAN\n';
  options.run = async (file, args) => file === 'nmcli' && args.includes('TYPE,STATE,DEVICE,CONNECTION') ? devices : null;
  const connected = await createWorkspaceMonitor(options)();
  assert.equal(connected.internet.networkName, 'Office LAN');
  assert.equal(connected.internet.networkType, 'ethernet');
  devices = 'tun:connected (externally):tailscale0:tailscale0\nwifi:disconnected:wlo1:\n';
  const disconnected = await createWorkspaceMonitor(options)();
  assert.equal(disconnected.internet.networkName, null);
  assert.equal(disconnected.internet.networkType, null);
});

test('connectivity accepts either HTTPS endpoint and rejects redirects / error pages', async () => {
  const result = await probeInternet(async (url) => ({ status: url.includes('gstatic') ? 503 : 204 }));
  assert.equal(result.reachable, true);
  assert.equal((await probeInternet(async () => ({ status: 302 }))).reachable, false);
  assert.equal((await probeInternet(async () => { throw new Error('DNS unavailable'); })).reachable, false);
});

test('concurrent readers share collection and manual refresh has a five-second limit', async (t) => {
  const options = await fixture(t);
  let time = 100_000, probes = 0;
  const monitor = createWorkspaceMonitor({ ...options, now: () => time, probe: async () => {
    probes++;
    return { reachable: true, latencyMs: 1 };
  } });
  const [first, concurrent] = await Promise.all([monitor(), monitor(true)]);
  assert.equal(first, concurrent);
  assert.equal(probes, 1);
  time += 4999;
  assert.equal(await monitor(true), first);
  time += 1;
  assert.notEqual(await monitor(true), first);
  assert.equal(probes, 2);
  time += 14_999;
  await monitor();
  assert.equal(probes, 2);
  time += 1;
  await monitor();
  assert.equal(probes, 3);
});

test('non-Linux hosts keep the quota dashboard usable without executing Linux commands', async () => {
  const result = await createWorkspaceMonitor({ platform: 'darwin', run: () => { throw new Error('must not run'); } })();
  assert.equal(result.supported, false);
});

// `systemctl --user show` for deploy/'s updater, as systemd prints it; `service`/`timer` override single properties.
function updateUnits({ service = {}, timer = {} } = {}) {
  const block = (fields) => Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n');
  return `${block({ Id: 'ai-quota-dashboard-update.service', LoadState: 'loaded', ActiveState: 'inactive', Result: 'success',
    ExecMainExitTimestamp: 'Thu 2026-10-29 19:45:49 +03', ExecMainStatus: '0', ...service })}\n\n${block({
    Id: 'ai-quota-dashboard-update.timer', LoadState: 'loaded', ActiveState: 'active', NextElapseUSecRealtime: 'Thu 2026-10-29 20:00:48 +03',
    LastTriggerUSec: 'Thu 2026-10-29 19:45:48 +03', Result: 'success', ...timer })}\n`;
}

test('reads the auto-update timer read-only, with one systemctl show call', async (t) => {
  const options = await fixture(t);
  const calls = [];
  const read = async (raw) => {
    calls.length = 0;
    const result = await createWorkspaceMonitor({ ...options, run: async (file, args) => {
      calls.push([file, ...args]);
      return file === 'systemctl' && args.includes('ai-quota-dashboard-update.service') ? raw : null;
    } })();
    return result.autoUpdate;
  };
  const lastRunAt = Date.parse('2026-10-29T19:45:49+03:00'), nextRunAt = Date.parse('2026-10-29T20:00:48+03:00');

  assert.deepEqual(await read(updateUnits()), { state: 'ok', timerActive: true, lastRunAt, lastExitStatus: 0, nextRunAt });
  const updaterCalls = calls.filter((c) => c.some((a) => a.includes('ai-quota-dashboard-update')));
  assert.deepEqual(updaterCalls, [['systemctl', '--user', 'show', 'ai-quota-dashboard-update.service', 'ai-quota-dashboard-update.timer',
    '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime', '--no-pager']]);
  // Nothing here controls a unit, reads the journal, or runs git.
  assert.ok(!calls.some(([file, ...args]) => file === 'journalctl' || file === 'git'
    || (file === 'systemctl' && args.some((a) => ['start', 'stop', 'restart', 'enable', 'disable', 'reset-failed'].includes(a)))));

  assert.deepEqual(await read(updateUnits({ service: { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1' } })),
    { state: 'failed', timerActive: true, lastRunAt, lastExitStatus: 1, nextRunAt });
  // A unit that reset its failed state still reports a non-zero exit.
  assert.equal((await read(updateUnits({ service: { ExecMainStatus: '1' } }))).state, 'failed');
  assert.deepEqual(await read(updateUnits({ service: { ActiveState: 'activating' } })),
    { state: 'running', timerActive: true, lastRunAt, lastExitStatus: 0, nextRunAt });
  assert.deepEqual(await read(updateUnits({ service: { ExecMainExitTimestamp: '' }, timer: { LastTriggerUSec: '', NextElapseUSecRealtime: '' } })),
    { state: 'never-run', timerActive: true, lastRunAt: null, lastExitStatus: null, nextRunAt: null });
  // The first run since boot is in progress: its start time is the only reading.
  assert.deepEqual(await read(updateUnits({ service: { ActiveState: 'activating', ExecMainExitTimestamp: '' } })),
    { state: 'running', timerActive: true, lastRunAt: Date.parse('2026-10-29T19:45:48+03:00'), lastExitStatus: null, nextRunAt });
  assert.deepEqual(await read(updateUnits({ timer: { ActiveState: 'inactive', NextElapseUSecRealtime: '' } })),
    { state: 'ok', timerActive: false, lastRunAt, lastExitStatus: 0, nextRunAt: null });
  const missing = { state: 'not-installed', timerActive: null, lastRunAt: null, lastExitStatus: null, nextRunAt: null };
  assert.deepEqual(await read(updateUnits({ service: { LoadState: 'not-found', ExecMainExitTimestamp: '' }, timer: { LoadState: 'not-found', NextElapseUSecRealtime: '', LastTriggerUSec: '' } })), missing);
  const unknown = { state: 'unknown', timerActive: null, lastRunAt: null, lastExitStatus: null, nextRunAt: null };
  assert.deepEqual(await read(null), unknown);
  assert.deepEqual(await read(updateUnits({ service: { LoadState: 'masked' } })), unknown);
});

test('systemctl runs in UTC, so a local zone name such as CET never hides a timestamp', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quota-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['systemctl', 'other']) {
    await writeFile(path.join(dir, name), '#!/bin/sh\nprintf %s "$TZ"\n');
    await chmod(path.join(dir, name), 0o755);
  }
  const saved = process.env.TZ;
  process.env.TZ = 'CET';
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  assert.equal(await command(path.join(dir, 'systemctl'), []), 'UTC');
  assert.equal(await command(path.join(dir, 'other'), []), 'CET'); // other commands keep the local zone
  // What systemctl then prints parses into the same instant.
  const options = await fixture(t);
  const raw = updateUnits({ service: { ExecMainExitTimestamp: 'Thu 2026-10-29 16:45:49 UTC' }, timer: { NextElapseUSecRealtime: 'Thu 2026-10-29 17:00:48 UTC' } });
  const { autoUpdate } = await createWorkspaceMonitor({ ...options, run: async (file, args) => file === 'systemctl' && args.includes('ai-quota-dashboard-update.service') ? raw : null })();
  assert.equal(autoUpdate.state, 'ok');
  assert.equal(autoUpdate.lastRunAt, Date.parse('2026-10-29T19:45:49+03:00'));
  assert.equal(autoUpdate.nextRunAt, Date.parse('2026-10-29T20:00:48+03:00'));
});
