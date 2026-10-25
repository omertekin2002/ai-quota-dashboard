import { readFile } from 'node:fs/promises';
import path from 'node:path';

const read = (file) => readFile(file, 'utf8').then((v) => v.trim()).catch(() => null);
const json = (value) => { try { return JSON.parse(value); } catch { return null; } };

export function unitProperties(raw) {
  return new Map(String(raw || '').trim().split(/\n\s*\n/).map((block) => {
    const fields = Object.fromEntries(block.split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    return [fields.Id, fields];
  }));
}

export function systemdTime(value) {
  if (!value || value === 'n/a') return null;
  const iso = value.replace(/^\w{3}\s+/, '').replace(' ', 'T')
    .replace(/ UTC$/, 'Z').replace(/ ([+-]\d{2})(?::?(\d{2}))?$/, (_, h, m) => `${h}:${m || '00'}`);
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function parsePressure(raw) {
  const result = {};
  for (const line of String(raw || '').split('\n')) {
    const [type, ...values] = line.trim().split(/\s+/);
    const fields = Object.fromEntries(values.map((v) => v.split('=')));
    if (['some', 'full'].includes(type) && ['avg10', 'avg60', 'avg300'].every((k) => Number.isFinite(Number(fields[k])))) {
      result[type] = Object.fromEntries(['avg10', 'avg60', 'avg300'].map((k) => [k, Number(fields[k])]));
    }
  }
  return result.some ? result : null;
}

async function resources(procRoot, run) {
  const [cpu, memory, io, processes, vmstat] = await Promise.all([
    ...['cpu', 'memory', 'io'].map((name) => read(path.join(procRoot, 'pressure', name))),
    // comm is the executable name only; never collect command lines or environments.
    run('ps', ['-eo', 'pid=,rss=,comm=', '--sort=-rss']), read(path.join(procRoot, 'vmstat')),
  ]);
  const topProcesses = String(processes || '').split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return m ? [{ pid: Number(m[1]), rssBytes: Number(m[2]) * 1024, name: m[3] }] : [];
  }).slice(0, 5);
  const oom = vmstat?.match(/^oom_kill\s+(\d+)$/m);
  return { pressure: { cpu: parsePressure(cpu), memory: parsePressure(memory), io: parsePressure(io) }, topProcesses, oomKills: oom ? Number(oom[1]) : null };
}

export function parseMounts(raw) {
  return String(raw || '').split('\n').flatMap((line) => {
    const [left, right] = line.split(' - ');
    if (!right) return [];
    const fields = left.split(' ');
    return [{ target: fields[4]?.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8))), type: right.split(' ')[0], readOnly: fields[5]?.split(',').includes('ro') }];
  });
}

async function storage(procRoot, run) {
  const raw = await read(path.join(procRoot, 'self/mountinfo'));
  const mounts = raw == null ? null : parseMounts(raw);
  return Promise.all([{ name: 'Internal SSD', path: '/' }, { name: 'T7 drive', path: '/mnt/nas' }].map(async (disk) => {
    const mount = mounts?.filter((m) => m.target === disk.path && m.type !== 'autofs').at(-1);
    if (!mount) return { ...disk, mounted: mounts == null ? null : false, readOnly: null, totalBytes: null, freeBytes: null, usedPct: null };
    // Only touch the T7 filesystem after confirming its real mount, not just an autofs entry.
    const df = await run('df', ['-B1', '--output=size,used,avail,pcent', disk.path]);
    const values = df?.trim().split('\n').at(-1)?.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%$/);
    return { ...disk, mounted: true, readOnly: mount.readOnly,
      totalBytes: values ? Number(values[1]) : null, freeBytes: values ? Number(values[3]) : null, usedPct: values ? Number(values[4]) : null };
  }));
}

async function backupStatus(run) {
  const raw = await run('systemctl', ['--user', 'show', 't7-backup.service', 't7-backup.timer',
    '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,NextElapseUSecRealtime', '--no-pager']);
  const units = unitProperties(raw), service = units.get('t7-backup.service'), timer = units.get('t7-backup.timer');
  const finishedAt = systemdTime(service?.ExecMainExitTimestamp);
  const running = service?.ActiveState === 'active' || service?.ActiveState === 'activating';
  const succeeded = service?.LoadState === 'loaded' && !running && service.Result === 'success' && service.ExecMainStatus === '0';
  return {
    state: !service || service.LoadState !== 'loaded' ? 'unknown' : running ? 'running'
      : !finishedAt ? 'never-run' : succeeded ? 'success' : 'failed',
    finishedAt, lastSuccessAt: finishedAt && succeeded ? finishedAt : null,
    scheduleActive: timer?.LoadState === 'loaded' ? timer.ActiveState === 'active' : null,
    nextRunAt: systemdTime(timer?.NextElapseUSecRealtime),
  };
}

async function tailscaleStatus(run) {
  const data = json(await run('tailscale', ['status', '--json']));
  if (!data) return { state: 'unknown', connections: [] };
  const counts = {};
  for (const peer of Object.values(data.Peer || {})) {
    if (!peer.Active || !peer.Online) continue;
    const type = peer.PeerRelay ? 'peer-relay' : peer.CurAddr ? 'direct' : peer.Relay ? 'relay' : 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  // Publish connection types/counts only, not peer names, IP addresses, or account details.
  return { state: data.BackendState === 'Running' ? 'running' : 'offline', connections: Object.entries(counts).map(([type, count]) => ({ type, count })) };
}

async function limitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw new Error('Response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function checkHttp({ id, service, label, url, kind }, fetchImpl = fetch, now = Date.now) {
  const start = performance.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(4000), redirect: 'manual',
      headers: { Accept: kind === 't3' ? 'text/html' : 'application/json', 'ngrok-skip-browser-warning': 'dashboard-health' } });
    const body = await limitedBody(response), data = json(body);
    const valid = kind === 't3' ? /<title>[^<]*T3 Code/i.test(body) : kind === 'cli' ? data?.status === 'ok' : data?.ok === true;
    return { id, service, label, state: response.ok && valid ? 'healthy' : 'unhealthy', httpStatus: response.status,
      latencyMs: Math.round(performance.now() - start), checkedAt: now(), detail: !response.ok ? `HTTP ${response.status}` : valid ? 'Responding' : 'Unexpected response' };
  } catch (error) {
    return { id, service, label, state: 'unhealthy', httpStatus: null, latencyMs: null, checkedAt: now(),
      detail: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'Timed out' : 'Unreachable' };
  }
}

export function createDiagnostics({ procRoot, run, fetchImpl = fetch, now = Date.now }) {
  let publicCache = null;
  async function healthChecks() {
    const [checks, agent] = await Promise.all([
      Promise.all([
        { id: 't3-local', service: 't3code.service', label: 'Local web', url: 'http://127.0.0.1:3773/', kind: 't3' },
        { id: 't3-tailnet', service: 't3code.service', label: 'Tailscale web', url: 'https://hp-laptop.tailf900b6.ts.net/', kind: 't3' },
        { id: 'cli-health', service: 'sh.brew.cliproxyapi.service', label: 'Backend health', url: 'http://127.0.0.1:8317/healthz', kind: 'cli' },
        { id: 'proxy-health', service: 'ngrok-proxy-llm.service', label: 'Proxy + backend', url: 'http://127.0.0.1:8330/health', kind: 'proxy' },
      ].map((check) => checkHttp(check, fetchImpl, now))),
      (async () => {
        try {
          const response = await fetchImpl('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(2000), redirect: 'manual' });
          if (response.ok) return json(await limitedBody(response));
          await response.body?.cancel();
          return null;
        } catch { return null; }
      })(),
    ]);
    const tunnel = agent?.tunnels?.find((t) => ['http://localhost:8330', 'http://127.0.0.1:8330'].includes(t.config?.addr));
    let url = null;
    try {
      const parsed = new URL(tunnel?.public_url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
        && /\.(ngrok-free\.(dev|app)|ngrok\.(app|io))$/.test(parsed.hostname)) url = `${parsed.origin}/health`;
    } catch {}
    const descriptor = { id: 'ngrok-public', service: 'ngrok-proxy-llm.service', label: 'Public tunnel' };
    if (!url) checks.push({ ...descriptor, state: 'unknown', detail: agent ? 'No matching tunnel' : 'Agent unavailable', checkedAt: now(), httpStatus: null, latencyMs: null });
    else {
      // Public ngrok requests consume its monthly allowance. Keep this check to once / 15 min.
      if (!publicCache || publicCache.url !== url || now() - publicCache.check.checkedAt >= 15 * 60_000) {
        publicCache = { url, check: await checkHttp({ ...descriptor, url, kind: 'proxy' }, fetchImpl, now) };
      }
      checks.push(publicCache.check);
    }
    return checks;
  }
  return async () => {
    const [resource, disks, backup, tailscale, health] = await Promise.all([
      resources(procRoot, run), storage(procRoot, run), backupStatus(run), tailscaleStatus(run), healthChecks(),
    ]);
    return { ...resource, disks, backup, tailscale, healthChecks: health };
  };
}
