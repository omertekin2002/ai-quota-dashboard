import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function memoryLevel(snapshot) {
  const availablePct = snapshot.memory ? 100 - snapshot.memory.usedPct : null;
  const pressure = snapshot.diagnostics?.pressure.memory;
  if ((availablePct != null && availablePct <= 5) || pressure?.full?.avg10 >= 10) return 'critical';
  if ((availablePct != null && availablePct <= 10) || pressure?.some?.avg10 >= 10 || pressure?.full?.avg10 >= 1) return 'warning';
  return snapshot.memory || pressure ? 'healthy' : 'unknown';
}

export const MAX_EVENTS = 100, MAX_ROUTINE_EVENTS = 20, EVENT_RETENTION_MS = 7 * 86400_000;

// An event's id is `${timestamp}:${key}:${title}`; the key says what it is about.
function eventKey(event) {
  const prefix = `${event.timestamp}:`;
  return typeof event.id === 'string' && event.id.startsWith(prefix) ? event.id.slice(prefix.length) : '';
}

// Info-level agent pipeline activity (job status changes, heartbeat recoveries, pause/resume, timer enabled).
export function isRoutineEvent(event) {
  return event.level === 'info' && eventKey(event).startsWith('agent-');
}

// Process start/exit events recorded by older builds; they are no longer kept.
function isProcessChurn(event) {
  return event.level === 'info' && eventKey(event).startsWith('agent-process:');
}

// Keeps seven days, newest first. Routine agent activity gets its own small budget and only
// fills room the other events leave, so it never pushes out an incident.
export function pruneEvents(events, now) {
  const recent = events
    .filter((e) => e && Number.isFinite(e.timestamp) && e.timestamp >= now - EVENT_RETENTION_MS && e.timestamp <= now && !isProcessChurn(e))
    .sort((a, b) => b.timestamp - a.timestamp);
  const main = recent.filter((e) => !isRoutineEvent(e)).slice(0, MAX_EVENTS);
  const routine = recent.filter(isRoutineEvent).slice(0, Math.min(MAX_ROUTINE_EVENTS, MAX_EVENTS - main.length));
  return [...main, ...routine].sort((a, b) => b.timestamp - a.timestamp);
}

export function createWorkspaceHistory({ file = null } = {}) {
  let loaded = false, events = [], samples = [], previous = null, lastSuccessAt = null, startedAt = null;
  return async function record(snapshot) {
    if (!loaded) {
      loaded = true;
      if (file) {
        try {
          const stored = JSON.parse(await readFile(file, 'utf8'));
          if (stored.version === 1) {
            events = Array.isArray(stored.events) ? stored.events : [];
            samples = Array.isArray(stored.samples) ? stored.samples : [];
            previous = stored.previous || null;
            lastSuccessAt = stored.lastSuccessAt || null;
            startedAt = stored.startedAt || null;
          }
        } catch {}
      }
    }
    const now = snapshot.generatedAt;
    startedAt ??= now;
    function add(key, title, level = 'info', timestamp = now) {
      const id = `${timestamp}:${key}:${title}`;
      if (!events.some((e) => e.id === id)) events.push({ id, timestamp, level, title });
    }
    const diagnostics = snapshot.diagnostics;
    const current = {
      uptimeSec: snapshot.uptimeSec, internet: snapshot.internet.state, network: snapshot.internet.networkName,
      disconnections: snapshot.internet.disconnections, memory: memoryLevel(snapshot), oomKills: diagnostics.oomKills,
      services: Object.fromEntries(snapshot.services.map((s) => [s.unit, { state: s.state, startedAt: s.startedAt, restarts: s.automaticRestarts }])),
      health: Object.fromEntries(diagnostics.healthChecks.map((c) => [c.id, c.state])),
      disks: Object.fromEntries(diagnostics.disks.map((d) => [d.path, d.mounted === false ? 'missing' : d.readOnly ? 'read-only' : d.usedPct >= 90 ? 'low' : d.usedPct != null ? 'healthy' : 'unknown'])),
      backup: diagnostics.backup.state, backupFinished: diagnostics.backup.finishedAt,
    };
    const workflow = diagnostics.agentWorkflow;
    if (workflow) {
      current.workflow = {
        pumpState: workflow.pumpState === 'unknown' ? previous?.workflow?.pumpState : workflow.pumpState,
        paused: workflow.paused ?? previous?.workflow?.paused,
        timerActive: workflow.timerActive ?? previous?.workflow?.timerActive,
        processes: workflow.available ? Object.fromEntries(workflow.processes.map((p) => [p.id, { pid: p.pid, name: p.name, state: p.state }])) : previous?.workflow?.processes,
        jobs: workflow.jobsAvailable && !workflow.partial ? Object.fromEntries([...workflow.activeJobs, ...workflow.recentJobs].map((j) => [j.id, { status: j.status, stale: j.stale }])) : previous?.workflow?.jobs,
      };
      const before = previous?.workflow, after = current.workflow;
      if (before) {
        if (after.pumpState === 'failed' && before.pumpState !== 'failed') add('agent-pump', 'Agent pipeline pump failed', 'critical');
        if (typeof before.paused === 'boolean' && after.paused !== before.paused) add('agent-pipeline', after.paused ? 'Agent pipeline paused' : 'Agent pipeline resumed');
        if (typeof before.timerActive === 'boolean' && after.timerActive !== before.timerActive) add('agent-timer', after.timerActive ? 'Agent pump timer enabled' : 'Agent pump timer inactive', after.timerActive ? 'info' : 'warning');
        if (workflow.available && before.processes) {
          // Pipeline subprocesses come and go every minute and the live list is already on the page,
          // so only a process that becomes stopped or zombie is worth an event.
          for (const [id, process] of Object.entries(after.processes)) {
            const old = before.processes[id];
            if (old && ['Z', 'T', 't'].includes(process.state) && process.state !== old.state) add(`agent-process:${id}`, `Workflow process stopped or zombie: ${process.name} (#${process.pid})`, 'warning');
          }
        }
        if (workflow.jobsAvailable && !workflow.partial && before.jobs) {
          for (const [id, job] of Object.entries(after.jobs)) {
            const old = before.jobs[id];
            if ((!old && ['launched', 'running'].includes(job.status)) || (old && old.status !== job.status)) add(`agent-job:${id}`, `Workflow job ${id}: ${job.status}`, ['failed', 'blocked', 'stalled'].includes(job.status) ? 'warning' : 'info');
            if (job.stale === true && old?.stale !== true) add(`agent-job:${id}`, `Workflow job ${job.status === 'launched' ? 'launch' : 'heartbeat'} overdue: ${id}`, 'warning');
            else if (job.stale === false && old?.stale === true) add(`agent-job:${id}`, `Workflow job heartbeat recovered: ${id}`);
          }
        }
      }
    }
    const update = snapshot.autoUpdate;
    if (update) {
      // A run in progress or an unreadable state keeps the last settled result, so neither fakes a change.
      current.autoUpdate = {
        result: ['ok', 'failed', 'never-run', 'not-installed'].includes(update.state) ? update.state : previous?.autoUpdate?.result,
        timerActive: update.timerActive ?? previous?.autoUpdate?.timerActive,
      };
      const before = previous?.autoUpdate, after = current.autoUpdate;
      if (before) {
        if (after.result === 'failed' && before.result !== 'failed') add('auto-update', `Dashboard auto-update failed${update.lastExitStatus != null ? ` (exit ${update.lastExitStatus})` : ''}`, 'warning');
        else if (after.result === 'ok' && before.result === 'failed') add('auto-update', 'Dashboard auto-update recovered');
        if (typeof before.timerActive === 'boolean' && after.timerActive !== before.timerActive) add('auto-update-timer', after.timerActive ? 'Dashboard auto-update timer active' : 'Dashboard auto-update timer inactive', after.timerActive ? 'info' : 'warning');
      }
    }
    if (!previous) add('monitor', 'Computer monitoring started');
    else {
      if (current.uptimeSec < previous.uptimeSec) add('boot', 'Computer restarted');
      if (current.internet !== previous.internet) add('internet', `Internet ${current.internet === 'online' ? 'connection restored' : `became ${current.internet}`}`, current.internet === 'online' ? 'info' : 'warning');
      if (current.network !== previous.network) add('network', current.network ? 'Network connected or changed' : 'Network disconnected', current.network ? 'info' : 'warning');
      else if (current.disconnections != null && previous.disconnections != null && current.disconnections > previous.disconnections) {
        add('link', `Network link dropped ${current.disconnections - previous.disconnections} time(s) between readings`, 'warning');
      }
      if (current.memory !== previous.memory) {
        if (['warning', 'critical'].includes(current.memory)) add('memory', 'Memory pressure elevated or available RAM low', current.memory);
        else if (current.memory === 'healthy' && ['warning', 'critical'].includes(previous.memory)) add('memory', 'Memory pressure recovered');
      }
      if (current.oomKills != null && previous.oomKills != null && current.oomKills > previous.oomKills) add('oom', 'Linux killed a process because memory ran out', 'critical');
      for (const service of snapshot.services) {
        const before = previous.services?.[service.unit], after = current.services[service.unit];
        if (!before) continue;
        if (after.state !== before.state) add(service.unit, `${service.name}: ${after.state}`, after.state === 'running' ? 'info' : 'warning');
        else if (after.state === 'running' && ((after.startedAt && before.startedAt && after.startedAt !== before.startedAt) || after.restarts > before.restarts)) add(service.unit, `${service.name} restarted`, 'warning');
      }
      for (const check of diagnostics.healthChecks) {
        const owner = snapshot.services.find((s) => s.unit === check.service)?.name;
        if (previous.health?.[check.id] && previous.health[check.id] !== check.state) add(check.id, `${owner ? `${owner} · ` : ''}${check.label}: ${check.state === 'healthy' ? 'response recovered' : check.state === 'unknown' ? 'check unavailable' : 'response failed'}`, check.state === 'healthy' ? 'info' : 'warning');
      }
      for (const disk of diagnostics.disks) {
        const state = current.disks[disk.path];
        if (previous.disks?.[disk.path] && previous.disks[disk.path] !== state) add(disk.path, `${disk.name}: ${state === 'healthy' ? 'storage available' : state === 'low' ? 'less than 10% free' : state}`, state === 'healthy' ? 'info' : 'warning');
      }
    }
    const backup = diagnostics.backup;
    if (backup.lastSuccessAt && (!lastSuccessAt || backup.lastSuccessAt > lastSuccessAt)) {
      lastSuccessAt = backup.lastSuccessAt;
      add('backup', 'T7 backup completed successfully', 'info', lastSuccessAt);
    }
    if (previous && backup.state === 'failed' && backup.finishedAt !== previous.backupFinished) add('backup', 'T7 backup failed', 'critical', backup.finishedAt || now);
    if (previous && backup.state === 'running' && previous.backup !== 'running') add('backup', 'T7 backup started');
    // One sample per 25 seconds, regardless of how often visitors press Refresh.
    if (!samples.length || now - samples.at(-1).timestamp >= 25_000) samples.push({ timestamp: now, state: snapshot.internet.state, latencyMs: snapshot.internet.latencyMs });
    samples = samples.filter((s) => s.timestamp >= now - 30 * 60_000 && s.timestamp <= now).slice(-80);
    events = pruneEvents(events, now);
    previous = current;
    let persisted = null;
    if (file) {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, events, samples, previous, lastSuccessAt, startedAt }), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        persisted = true;
      } catch {
        persisted = false;
        await unlink(`${file}.tmp`).catch(() => {});
      }
    }
    return { events: [...events], samples: [...samples], lastSuccessAt, startedAt, persisted };
  };
}
