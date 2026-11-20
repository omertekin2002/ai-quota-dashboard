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

test('/api/workspace serves the trimmed history view with its totals and span', async (t) => {
  const options = await fixture(t), historyFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'quota-workspace-history-')), 'history.json');
  t.after(() => rm(path.dirname(historyFile), { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  // 40 one-off service restarts over the last day, from a history saved by this build.
  const events = Array.from({ length: 40 }, (_, i) => ({ id: `${now - (i + 1) * 30 * 60_000}:t3code.service:T3 Code restarted`, timestamp: now - (i + 1) * 30 * 60_000, level: 'warning', title: 'T3 Code restarted' }));
  await writeFile(historyFile, JSON.stringify({ version: 1, events, samples: [], previous: null, lastSuccessAt: null, startedAt: now - 2 * 86400_000, droppedAt: null }));
  const { history } = await createWorkspaceMonitor({ ...options, historyFile, now: () => now })();
  assert.equal(history.events.length, 20);
  assert.equal(history.eventCount, 41); // plus the monitoring-started marker
  assert.deepEqual([history.episodes.length, history.episodeCount], [20, 40]);
  assert.deepEqual([history.oldestAt, history.trimmed, history.eventLimit], [now - 2 * 86400_000, false, 1000]);
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
    // The history's fields are covered by the unreachable tests below.
    const { unreachableSince, lastOkAt, unreachableForMs, unreachableWarning, ...status } = result.autoUpdate;
    return status;
  };
  const lastRunAt = Date.parse('2026-10-29T19:45:49+03:00'), nextRunAt = Date.parse('2026-10-29T20:00:48+03:00');

  assert.deepEqual(await read(updateUnits()), { state: 'ok', timerActive: true, lastRunAt, lastExitStatus: 0, nextRunAt });
  const updaterCalls = calls.filter((c) => c.some((a) => a.includes('ai-quota-dashboard-update')));
  assert.deepEqual(updaterCalls, [['systemctl', '--user', 'show', 'ai-quota-dashboard-update.service', 'ai-quota-dashboard-update.timer',
    '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime', '--no-pager']]);
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

// What update.sh writes to the journal for a run, as `journalctl -o cat` prints it.
const FETCH_REFUSAL = [
  'Starting ai-quota-dashboard-update.service - Fast-forward the AI quota dashboard from origin/main...',
  "fatal: unable to access 'https://github.com/omertekin2002/ai-quota-dashboard.git/': Could not resolve host: github.com",
  'ai-quota-dashboard-update: refusing: git fetch origin main failed or timed out after 60s',
  'ai-quota-dashboard-update.service: Main process exited, code=exited, status=1/FAILURE',
  "ai-quota-dashboard-update.service: Failed with result 'exit-code'.",
].join('\n');
const LOCAL_CHANGES = [
  'ai-quota-dashboard-update: refusing: /home/user/ai-quota-dashboard has local changes:',
  ' M index.html',
  'ai-quota-dashboard-update.service: Main process exited, code=exited, status=1/FAILURE',
].join('\n');

test('a failed run whose journal shows only the fetch refusal is unreachable, read from the journal once per run', async (t) => {
  const options = await fixture(t);
  let units = updateUnits({ service: { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1', ExecMainStartTimestamp: 'Thu 2026-10-29 19:44:48 +03' } });
  let journal = FETCH_REFUSAL;
  const journalCalls = [];
  let time = Date.parse('2026-10-29T19:46:00+03:00');
  const monitor = createWorkspaceMonitor({ ...options, now: () => time, run: async (file, args) => {
    if (file === 'journalctl') { journalCalls.push(args); return journal; }
    return file === 'systemctl' && args.includes('ai-quota-dashboard-update.service') ? units : null;
  } });
  const first = (await monitor()).autoUpdate;
  assert.equal(first.state, 'unreachable');
  assert.equal(first.lastExitStatus, 1);
  assert.equal(first.unreachableSince, Date.parse('2026-10-29T19:45:49+03:00'));
  assert.equal(first.unreachableWarning, false);
  // Only this run's lines, bounded, read-only.
  assert.deepEqual(journalCalls, [['--user', '-u', 'ai-quota-dashboard-update.service',
    `--since=@${Date.parse('2026-10-29T19:44:48+03:00') / 1000}`, `--until=@${Date.parse('2026-10-29T19:45:49+03:00') / 1000 + 1}`,
    '-o', 'cat', '-n', '20', '--no-pager']]);
  // The next 30-second polls of the same run don't read the journal again.
  for (let i = 0; i < 3; i++) {
    time += 30_000;
    assert.equal((await monitor(true)).autoUpdate.state, 'unreachable');
  }
  assert.equal(journalCalls.length, 1);
  // The next run failed for a different reason: its own journal is read once, and it is a real failure.
  units = units.replace('19:45:49', '20:00:49').replace('19:44:48', '20:00:48');
  journal = LOCAL_CHANGES;
  time += 30_000;
  assert.equal((await monitor(true)).autoUpdate.state, 'failed');
  time += 30_000;
  assert.equal((await monitor(true)).autoUpdate.state, 'failed');
  assert.equal(journalCalls.length, 2);
});

test('a failed run stays failed when its journal shows another refusal, or cannot be read', async (t) => {
  const options = await fixture(t);
  const failed = updateUnits({ service: { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1', ExecMainStartTimestamp: 'Thu 2026-10-29 19:44:48 +03' } });
  const read = async (journal, units = failed) => {
    const calls = [];
    const result = await createWorkspaceMonitor({ ...options, run: async (file, args) => {
      calls.push(file);
      if (file === 'journalctl') return journal;
      return file === 'systemctl' && args.includes('ai-quota-dashboard-update.service') ? units : null;
    } })();
    return { state: result.autoUpdate.state, journal: calls.filter((f) => f === 'journalctl').length };
  };
  assert.deepEqual(await read(FETCH_REFUSAL), { state: 'unreachable', journal: 1 });
  assert.deepEqual(await read(LOCAL_CHANGES), { state: 'failed', journal: 1 });
  for (const refusal of ['/home/user/ai-quota-dashboard is not on a branch (detached HEAD)', "/home/user/ai-quota-dashboard is on branch 'dev', not 'main'",
    "local main (abc1234) has commits origin/main (def5678) doesn't; can't fast-forward"]) {
    assert.deepEqual(await read(`ai-quota-dashboard-update: refusing: ${refusal}`), { state: 'failed', journal: 1 }, refusal);
  }
  // A failed restart prints no refusal at all.
  assert.deepEqual(await read('ai-quota-dashboard-update: fast-forwarded abc1234 → def5678\nFailed to restart ai-quota-dashboard.service: Unit not found.'), { state: 'failed', journal: 1 });
  // journalctl failed, or found nothing.
  assert.deepEqual(await read(null), { state: 'failed', journal: 1 });
  assert.deepEqual(await read('-- No entries --'), { state: 'failed', journal: 1 });
  // The fetch refusal quoted inside another refusal's output is not a line of its own.
  assert.deepEqual(await read(`${LOCAL_CHANGES}\n M notes: ai-quota-dashboard-update: refusing: git fetch origin main failed or timed out after 60s`), { state: 'failed', journal: 1 });
  // Without a start time there is no bounded journal read, so it stays a failure.
  assert.deepEqual(await read(FETCH_REFUSAL, updateUnits({ service: { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1' } })), { state: 'failed', journal: 0 });
  // ok, running, never-run and not-installed readings never read the journal.
  const start = { ExecMainStartTimestamp: 'Thu 2026-10-29 19:44:48 +03' };
  for (const service of [{ ...start }, { ...start, ActiveState: 'activating' }, { ...start, ExecMainExitTimestamp: '' }, { LoadState: 'not-found', ExecMainExitTimestamp: '' }]) {
    assert.equal((await read(FETCH_REFUSAL, updateUnits({ service }))).journal, 0, JSON.stringify(service));
  }
});
