import { open, readlink, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unitProperties, systemdTime } from './diagnostics.mjs';

const date = (value) => { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : null; };
const inside = (file, dir) => !!file && (file === dir || file.startsWith(`${dir}${path.sep}`));
async function limitedRead(file, limit, prefix = false) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > limit && !prefix ? null : buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8');
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
async function readJson(file) {
  try { return JSON.parse(await limitedRead(file, 256 * 1024)); } catch { return null; }
}
async function mapLimited(items, fn) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (index < items.length) { const i = index++; results[i] = await fn(items[i]); }
  }));
  return results;
}

const COMMANDS = new Set(['tick', 'kick', 'status', 'digest', 'pause', 'resume', 'repos', 'local-sync', 'labels', 'doctor', 'job', 'workspace', 'stack', 'heavy', 'pr-wait', 'ci-wait', 'review']);
const RUNTIMES = /^(bun|node|nodejs|deno|bash|sh|zsh|python[\d.]*)$/;
const RUNTIME_NAMES = /^(bun|node(?:-MainThread)?|nodejs|deno|bash|sh|zsh|python[\d.]*|agentctl(?:\.(?:ts|js|mjs|cjs))?)$/;
function agentCommand(argv) {
  const binary = path.basename(argv[0] || '');
  let index = 0;
  if (binary !== 'agentctl') {
    if (!RUNTIMES.test(binary)) return null;
    index = binary === 'bun' && argv[1] === 'run' ? 2 : 1;
    // Inspect the script position only, never shell commands, eval text, prompts, or later arguments.
    if (!/^agentctl(?:\.(ts|js|mjs|cjs))?$/.test(path.basename(argv[index] || ''))) return null;
  }
  const command = argv[index + 1];
  return COMMANDS.has(command) ? command : 'command';
}

export function createAgentWorkflowMonitor({ procRoot = '/proc', run, now = Date.now,
  workflowHome = process.env.AGENT_HOME || path.join(os.homedir(), '.agent-workflow'),
  repoRoot = path.join(os.homedir(), 'Desktop/Grind/build-workflow'),
  t3Worktrees = path.join(os.homedir(), '.t3/worktrees/build-workflow'), uid = process.getuid?.() ?? 1000,
} = {}) {
  let known = new Map();
  const roots = [workflowHome, repoRoot, t3Worktrees].map((p) => path.resolve(p));

  async function processes() {
    const raw = await run('ps', ['-u', String(uid), '-o', 'pid=,ppid=,stat=,etimes=,pcpu=,rss=,comm=']);
    if (raw == null) return { available: false, count: null, processes: [], rssBytes: null, cpuPct: null, truncated: false };
    const rows = String(raw).split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.+?)\s*$/);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), state: m[3][0], elapsedSec: Number(m[4]), cpuPct: Number(m[5]), rssBytes: Number(m[6]) * 1024, name: m[7] }] : [];
    });
    if (String(raw).trim() && !rows.length) return { available: false, count: null, processes: [], rssBytes: null, cpuPct: null, truncated: false };
    const metadata = await mapLimited(rows, async (p) => {
      const cwd = await readlink(path.join(procRoot, String(p.pid), 'cwd')).catch(() => null);
      // Read a bounded prefix for identity matching and immediately discard it. Nothing is published.
      const argv = RUNTIME_NAMES.test(p.name)
        ? (await limitedRead(path.join(procRoot, String(p.pid), 'cmdline'), 4096, true))?.split('\0') || [] : [];
      return { ...p, scoped: roots.some((root) => inside(cwd, root)), command: agentCommand(argv) };
    });
    const byPid = new Map(metadata.map((p) => [p.pid, p]));
    const matched = await mapLimited(metadata, async (p) => {
      const ancestors = []; let current = p;
      const visited = new Set();
      while (current && !visited.has(current.pid)) {
        ancestors.push(current); visited.add(current.pid); current = byPid.get(current.ppid);
      }
      const lineage = ancestors.reverse();
      const root = lineage.find((a) => a.command) || lineage.find((a) => a.scoped);
      const prior = known.get(p.pid);
      if (!root && !prior) return null;
      const rawStat = await limitedRead(path.join(procRoot, String(p.pid), 'stat'), 8192);
      const startTicks = rawStat?.slice(rawStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!startTicks || !/^\d+$/.test(startTicks)) return null; // exited during collection
      if (!root && prior.startTicks !== startTicks) return null; // PID was reused
      const { scoped, command, ...safe } = p;
      return { ...safe, id: `${p.pid}:${startTicks}`, startTicks, rootPid: root?.pid ?? prior.rootPid,
        role: command ? 'agentctl' : root?.pid === p.pid ? 'workflow' : 'child', command: command || null };
    });
    const all = matched.filter(Boolean).sort((a, b) => a.rootPid - b.rootPid || a.pid - b.pid);
    known = new Map(all.map((p) => [p.pid, { startTicks: p.startTicks, rootPid: p.rootPid }]));
    return { available: true, count: all.length, processes: all.slice(0, 100), truncated: all.length > 100,
      rssBytes: all.reduce((n, p) => n + p.rssBytes, 0), cpuPct: all.reduce((n, p) => n + p.cpuPct, 0) };
  }

  async function pipeline() {
    const [status, config, paused, unitsRaw, files] = await Promise.all([
      readJson(path.join(workflowHome, 'status.json')), readJson(path.join(repoRoot, 'config.json')),
      stat(path.join(workflowHome, 'PAUSED')).then(() => true).catch((e) => e.code === 'ENOENT' ? false : null),
      run('systemctl', ['--user', 'show', 'agent-pump.service', 'agent-pump.timer', '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,LastTriggerUSec', '--no-pager']),
      readdir(path.join(workflowHome, 'jobs')).catch(() => null),
    ]);
    const units = unitProperties(unitsRaw), service = units.get('agent-pump.service'), timer = units.get('agent-pump.timer');
    const pumpState = service?.LoadState !== 'loaded' ? 'unknown' : ['active', 'activating'].includes(service.ActiveState) ? 'running'
      : service.ActiveState === 'failed' || (service.Result && service.Result !== 'success') || (service.ExecMainStatus && service.ExecMainStatus !== '0') ? 'failed' : 'idle';
    const filesWithTimes = await mapLimited((files || []).filter((f) => /^[a-z0-9][a-z0-9-]{5,100}\.json$/.test(f)), async (file) => ({ file, modifiedAt: await stat(path.join(workflowHome, 'jobs', file)).then((s) => s.mtimeMs).catch(() => 0) }));
    const selected = filesWithTimes.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 500);
    let invalid = 0;
    const staleMinutes = Number.isFinite(config?.staleMinutes) && config.staleMinutes > 0 ? config.staleMinutes : 60;
    const launchMinutes = Number.isFinite(config?.launchTimeoutMinutes) && config.launchTimeoutMinutes > 0 ? config.launchTimeoutMinutes : 15;
    const jobs = (await mapLimited(selected, async ({ file }) => {
      const job = await readJson(path.join(workflowHome, 'jobs', file));
      if (!job || typeof job.id !== 'string' || job.id !== file.slice(0, -5) || !/^[a-z0-9][a-z0-9-]{5,100}$/.test(job.id) || !['launched', 'running', 'done', 'failed', 'blocked', 'stalled'].includes(job.status)) { invalid++; return null; }
      const createdAt = date(job.createdAt), heartbeatAt = date(job.heartbeatAt), startedAt = date(job.startedAt), finishedAt = date(job.finishedAt);
      const reference = job.status === 'launched' ? createdAt : heartbeatAt ?? startedAt ?? createdAt;
      const stale = ['launched', 'running'].includes(job.status) && reference != null ? now() - reference > (job.status === 'launched' ? launchMinutes : staleMinutes) * 60_000 : null;
      return { id: job.id, status: job.status, mode: ['task', 'plan', 'implement'].includes(job.mode) ? job.mode : 'unknown', createdAt, startedAt, heartbeatAt, finishedAt, stale };
    })).filter(Boolean);
    const active = jobs.filter((j) => ['launched', 'running'].includes(j.status));
    const decision = typeof status?.decision === 'string' ? status.decision : '';
    const reason = pumpState === 'failed' ? 'Pump failed' : paused === true ? 'Paused' : /^quota exhausted/i.test(decision) ? 'Waiting for quota'
      : /^not configured/i.test(decision) ? 'Not configured' : /^(low memory|not enough memory|insufficient memory)/i.test(decision) ? 'Waiting for memory'
      : active.length ? 'Jobs active' : pumpState === 'running' ? 'Pump running' : pumpState === 'failed' ? 'Pump failed' : status ? 'Waiting for next tick' : 'Status unavailable';
    return { paused, reason, pumpState, timerActive: timer?.LoadState === 'loaded' ? timer.ActiveState === 'active' : null,
      lastTickAt: date(status?.at), lastRunAt: systemdTime(service?.ExecMainExitTimestamp),
      jobsAvailable: files != null, partial: invalid > 0 || filesWithTimes.length > 500,
      activeCount: files == null ? null : active.length, activeJobs: active.slice(0, 20),
      recentJobs: jobs.filter((j) => j.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 5),
      staleCount: active.filter((j) => j.stale).length, staleMinutes, launchMinutes };
  }

  return async () => {
    const [process, state] = await Promise.all([processes(), pipeline()]);
    return { ...state, ...process };
  };
}
