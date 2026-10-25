import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function memoryLevel(snapshot) {
  const availablePct = snapshot.memory ? 100 - snapshot.memory.usedPct : null;
  const pressure = snapshot.diagnostics?.pressure.memory;
  if ((availablePct != null && availablePct <= 5) || pressure?.full?.avg10 >= 10) return 'critical';
  if ((availablePct != null && availablePct <= 10) || pressure?.some?.avg10 >= 10 || pressure?.full?.avg10 >= 1) return 'warning';
  return snapshot.memory || pressure ? 'healthy' : 'unknown';
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
          for (const [id, process] of Object.entries(after.processes)) {
            if (!before.processes[id]) add(`agent-process:${id}`, `Workflow process started: ${process.name} (#${process.pid})`);
            else if (['Z', 'T', 't'].includes(process.state) && process.state !== before.processes[id].state) add(`agent-process:${id}`, `Workflow process stopped or zombie: ${process.name} (#${process.pid})`, 'warning');
          }
          for (const [id, process] of Object.entries(before.processes)) if (!after.processes[id]) add(`agent-process:${id}`, `Workflow process exited: ${process.name} (#${process.pid})`);
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
    events = events.filter((e) => e.timestamp >= now - 7 * 86400_000 && e.timestamp <= now).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
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
