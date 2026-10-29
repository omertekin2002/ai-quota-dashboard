import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnostics, unitProperties, systemdTime } from './diagnostics.mjs';
import { createWorkspaceHistory, memoryLevel } from './workspace-history.mjs';
import { createAgentWorkflowMonitor } from './agent-workflow.mjs';

const exec = promisify(execFile);
const SERVICES = [
  { name: 'CLIProxyAPI', unit: 'sh.brew.cliproxyapi.service', scope: 'user' },
  { name: 'ngrok-proxy-llm', unit: 'ngrok-proxy-llm.service', scope: 'user' },
  { name: 'T3 Code', unit: 't3code.service', scope: 'user' },
  { name: 'Tailscale', unit: 'tailscaled.service', scope: 'system' },
  { name: 'Network watchdog', unit: 'net-watchdog.service', scope: 'user' },
];

async function text(file) {
  return readFile(file, 'utf8').then((s) => s.trim()).catch(() => null);
}
async function entries(dir) {
  return readdir(dir).then((names) => names.sort()).catch(() => []);
}
function number(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export async function command(file, args, { timeout = 4000, maxBuffer = 64 * 1024 } = {}) {
  try {
    const { stdout } = await exec(file, args, {
      timeout,
      maxBuffer,
      // systemctl prints timestamps in the local zone, and systemdTime() can't parse zone names such as CET or EEST.
      env: { ...process.env, LC_ALL: 'C', SYSTEMD_PAGER: 'cat', ...(path.basename(file) === 'systemctl' ? { TZ: 'UTC' } : {}) },
    });
    return stdout;
  } catch {
    return null;
  }
}

async function powerStatus(sysRoot) {
  const base = path.join(sysRoot, 'class/power_supply');
  const supplies = await Promise.all((await entries(base)).map(async (name) => {
    const dir = path.join(base, name);
    const [type, capacity, status, online, present] = await Promise.all(
      ['type', 'capacity', 'status', 'online', 'present'].map((file) => text(path.join(dir, file))),
    );
    return { name, type, percent: number(capacity), status, online: number(online), present: number(present) };
  }));
  const adapters = supplies.filter((s) => s.type !== 'Battery' && s.online != null);
  return {
    acOnline: adapters.length ? adapters.some((s) => s.online === 1) : null,
    batteries: supplies.filter((s) => s.type === 'Battery' && s.present !== 0).map((s) => ({
      name: s.name,
      percent: s.percent != null && s.percent >= 0 && s.percent <= 100 ? s.percent : null,
      status: s.status || 'Unknown',
    })),
  };
}

async function temperatures(sysRoot) {
  const base = path.join(sysRoot, 'class/hwmon');
  const names = { k10temp: 'CPU', coretemp: 'CPU', zenpower: 'CPU', amdgpu: 'GPU', nouveau: 'GPU', i915: 'GPU', nvme: 'SSD' };
  const sensors = (await Promise.all((await entries(base)).map(async (device) => {
    const dir = path.join(base, device);
    const name = names[await text(path.join(dir, 'name'))];
    if (!name) return null;
    const readings = await Promise.all((await entries(dir)).filter((f) => /^temp\d+_input$/.test(f)).map(async (file) => {
      const [input, critical] = await Promise.all([
        text(path.join(dir, file)), text(path.join(dir, file.replace('_input', '_crit'))),
      ]);
      const value = number(input), crit = number(critical);
      if (value == null || value < -40_000 || value > 150_000) return null;
      return { name, celsius: value / 1000, criticalCelsius: crit != null && crit > 0 ? crit / 1000 : null };
    }));
    // One reading per device: the hottest core / SSD sensor.
    return readings.filter(Boolean).sort((a, b) => b.celsius - a.celsius)[0] || null;
  }))).filter(Boolean);
  if (sensors.length) return sensors.sort((a, b) => ['CPU', 'GPU', 'SSD'].indexOf(a.name) - ['CPU', 'GPU', 'SSD'].indexOf(b.name));
  const thermal = path.join(sysRoot, 'class/thermal');
  return (await Promise.all((await entries(thermal)).filter((f) => /^thermal_zone\d+$/.test(f)).map(async (zone) => {
    const value = number(await text(path.join(thermal, zone, 'temp')));
    return value != null && value >= -40_000 && value <= 150_000
      ? { name: 'System', celsius: value / 1000, criticalCelsius: null } : null;
  }))).filter(Boolean);
}

async function memoryStatus(procRoot) {
  const raw = await text(path.join(procRoot, 'meminfo'));
  const values = Object.fromEntries([...String(raw || '').matchAll(/^(\w+):\s+(\d+) kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  if (!values.MemTotal || values.MemAvailable == null) return null;
  return {
    totalBytes: values.MemTotal,
    availableBytes: values.MemAvailable,
    usedBytes: values.MemTotal - values.MemAvailable,
    usedPct: 100 * (1 - values.MemAvailable / values.MemTotal),
    swapUsedBytes: values.SwapTotal != null && values.SwapFree != null ? values.SwapTotal - values.SwapFree : null,
  };
}

export async function probeInternet(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const start = performance.now();
  try {
    // Either independent HTTPS endpoint can confirm connectivity; a redirect is not success.
    await Promise.any(['https://connectivitycheck.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'].map(async (url) => {
      const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
      if (res.status !== 204) throw new Error('Connectivity check failed');
    }));
    return { reachable: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { reachable: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function connectedNetwork(run) {
  // Keep the name last and disable nmcli's escaping so colons/backslashes in names survive.
  const raw = await run('nmcli', ['-t', '-e', 'no', '-f', 'TYPE,STATE,DEVICE,CONNECTION', 'device', 'status']);
  const devices = String(raw || '').split('\n').map((line) => {
    const [type, state, device, ...name] = line.split(':');
    return { type, state, device, name: name.join(':') };
  }).filter((d) => /^connected(?: \(externally\))?$/.test(d.state));
  // Ignore virtual adapters such as Tailscale, Docker bridges, and loopback.
  const device = devices.find((d) => d.type === 'ethernet') || devices.find((d) => d.type === 'wifi');
  if (!device) return { networkName: null, networkType: null, signalPct: null, linkRate: null, device: null };
  let name = device.name;
  let signalPct = null, linkRate = null;
  if (device.type === 'wifi') {
    // Read the associated SSID, which may differ from the saved connection profile's name.
    const wifi = await run('nmcli', ['-t', '-e', 'no', '-f', 'ACTIVE,SIGNAL,RATE,SSID', 'device', 'wifi', 'list', '--rescan', 'no', 'ifname', device.device]);
    const active = String(wifi || '').split('\n').find((line) => line.startsWith('yes:'));
    if (active) {
      const [, signal, rate, ...ssid] = active.split(':');
      name = ssid.join(':') || name;
      const n = number(signal);
      signalPct = n != null && n >= 0 && n <= 100 ? n : null;
      linkRate = rate || null;
    }
  }
  return { networkName: name || null, networkType: device.type, signalPct, linkRate, device: device.device };
}

async function internetStatus(run, probe, sysRoot) {
  const [raw, https, network] = await Promise.all([
    run('nmcli', ['-t', '-f', 'CONNECTIVITY', 'general']), probe(), connectedNetwork(run),
  ]);
  const connectivity = raw?.trim();
  const state = https.reachable ? 'online'
    : connectivity === 'portal' ? 'portal'
    : connectivity === 'none' ? 'offline'
    : ['full', 'limited'].includes(connectivity) ? 'limited' : 'unknown';
  const disconnections = network.device && /^[a-zA-Z0-9_.-]+$/.test(network.device)
    ? number(await text(path.join(sysRoot, 'class/net', network.device, 'carrier_down_count'))) : null;
  const { device, ...connection } = network;
  return { state, latencyMs: https.latencyMs, connectivity: connectivity || 'unknown', ...connection, disconnections };
}

async function serviceStatus(run) {
  const groups = await Promise.all(['user', 'system'].map(async (scope) => {
    const args = [
      ...(scope === 'user' ? ['--user'] : []), 'show',
      ...SERVICES.filter((s) => s.scope === scope).map((s) => s.unit),
      '--property=Id,LoadState,ActiveState,SubState,NRestarts,ActiveEnterTimestamp', '--no-pager',
    ];
    const raw = await run('systemctl', args);
    const units = unitProperties(raw);
    return SERVICES.filter((s) => s.scope === scope).map((service) => {
      const u = units.get(service.unit);
      const state = !u ? 'unknown' : u.LoadState === 'not-found' ? 'not-found'
        : u.ActiveState === 'failed' ? 'failed'
        : u.LoadState !== 'loaded' ? 'unknown'
        : u.ActiveState === 'active' && u.SubState === 'running' ? 'running'
        : u.ActiveState === 'inactive' ? 'stopped'
        : ['activating', 'deactivating', 'reloading'].includes(u.ActiveState) ? u.ActiveState
        : u.ActiveState === 'active' ? u.SubState || 'unknown' : 'unknown';
      return { ...service, state, automaticRestarts: number(u?.NRestarts), startedAt: systemdTime(u?.ActiveEnterTimestamp) };
    });
  }));
  const services = groups.flat();
  return SERVICES.map((s) => services.find((v) => v.unit === s.unit));
}

// Read-only view of deploy/'s updater units. Never starts, restarts or enables them.
async function autoUpdateStatus(run) {
  const raw = await run('systemctl', ['--user', 'show', 'ai-quota-dashboard-update.service', 'ai-quota-dashboard-update.timer',
    '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime', '--no-pager']);
  const units = unitProperties(raw);
  const service = units.get('ai-quota-dashboard-update.service'), timer = units.get('ai-quota-dashboard-update.timer');
  const unknown = { state: 'unknown', timerActive: null, lastRunAt: null, lastExitStatus: null, nextRunAt: null };
  if (!service || !timer) return unknown;
  if (service.LoadState === 'not-found') return { ...unknown, state: 'not-installed' };
  if (service.LoadState !== 'loaded' || !['loaded', 'not-found'].includes(timer.LoadState)) return unknown;
  const finishedAt = systemdTime(service.ExecMainExitTimestamp);
  const exitStatus = finishedAt ? number(service.ExecMainStatus) : null;
  const state = ['active', 'activating', 'deactivating', 'reloading'].includes(service.ActiveState) ? 'running'
    : service.ActiveState === 'failed' || (service.Result && service.Result !== 'success') ? 'failed'
    : !finishedAt ? 'never-run' : exitStatus !== 0 ? 'failed' : 'ok';
  return {
    state,
    // A missing timer means nothing schedules the updater, the same as a stopped one.
    timerActive: timer.LoadState === 'loaded' ? timer.ActiveState === 'active' : false,
    // The last completed run; a first run still in progress reports when the timer started it.
    lastRunAt: finishedAt ?? (state === 'running' ? systemdTime(timer.LastTriggerUSec) : null),
    lastExitStatus: exitStatus,
    nextRunAt: systemdTime(timer.NextElapseUSecRealtime),
  };
}

export function createWorkspaceMonitor({
  sysRoot = '/sys', procRoot = '/proc', run = command, probe = probeInternet,
  now = Date.now, platform = process.platform, fetchImpl = fetch, historyFile = null, workflowHome, repoRoot, t3Worktrees,
} = {}) {
  let cache = null, inflight = null;
  const diagnostics = createDiagnostics({ procRoot, run, fetchImpl, now });
  const recordHistory = createWorkspaceHistory({ file: historyFile });
  const agentWorkflow = createAgentWorkflowMonitor({ procRoot, run, now, workflowHome, repoRoot, t3Worktrees });
  return async function getStatus(force = false) {
    // Independent from the provider quota cache; coalesce concurrent requests.
    if (cache && now() - cache.generatedAt < (force ? 5000 : 15_000)) return cache;
    inflight ??= (async () => {
      if (platform !== 'linux') return { generatedAt: now(), supported: false };
      const [power, sensors, memory, internet, services, autoUpdate, model, uptime, diagnostic, workflow] = await Promise.all([
        powerStatus(sysRoot), temperatures(sysRoot), memoryStatus(procRoot), internetStatus(run, probe, sysRoot),
        serviceStatus(run), autoUpdateStatus(run), text(path.join(sysRoot, 'class/dmi/id/product_name')), text(path.join(procRoot, 'uptime')), diagnostics(), agentWorkflow(),
      ]);
      diagnostic.agentWorkflow = workflow;
      const snapshot = {
        generatedAt: now(), supported: true, model: model || 'Linux computer',
        uptimeSec: number(uptime?.split(/\s+/)[0]) ?? os.uptime(),
        power, temperatures: sensors, memory, internet, services, autoUpdate, diagnostics: diagnostic,
      };
      snapshot.history = await recordHistory(snapshot);
      snapshot.diagnostics.backup.lastSuccessAt = snapshot.history.lastSuccessAt;
      snapshot.diagnostics.memoryLevel = memoryLevel(snapshot);
      return snapshot;
    })().then((value) => (cache = value)).finally(() => (inflight = null));
    return inflight;
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const getWorkspaceStatus = createWorkspaceMonitor({ historyFile: path.join(HERE, '.cache', 'workspace-history.json') });

export function startWorkspaceMonitoring() {
  const update = () => getWorkspaceStatus(true).catch(() => {});
  update();
  const timer = setInterval(update, 30_000);
  timer.unref();
  return timer;
}
