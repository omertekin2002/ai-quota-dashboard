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

// Memory pressure counts as recovered only after readings have stayed healthy this long. On a busy machine
// the level flips every 30 seconds to 2 minutes, and each flip would otherwise be its own incident.
export const MEMORY_SETTLE_MS = 5 * 60_000;

const STOPPED_STATES = ['Z', 'T', 't'];
const isPressure = (level) => level === 'warning' || level === 'critical';

// An event's id is `${timestamp}:${key}:${title}`; the key says what it is about.
function eventKey(event) {
  const prefix = `${event.timestamp}:`;
  return typeof event.id === 'string' && event.id.startsWith(prefix) ? event.id.slice(prefix.length) : '';
}

// The key alone, without the title that follows it in the id.
function keyOf(event) {
  const rest = eventKey(event), suffix = `:${event.title}`;
  return rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : '';
}

// Info-level agent pipeline activity (job status changes, heartbeat recoveries, pause/resume). The pump timer
// being enabled again is not routine: it ends an incident, so it must outlive the warning that opened it.
export function isRoutineEvent(event) {
  return event.level === 'info' && eventKey(event).startsWith('agent-') && !eventKey(event).startsWith('agent-timer:');
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

const LEVEL_RANK = { info: 0, warning: 1, critical: 2 };

// How an event takes part in incidents: 'open' starts or extends one, 'close' ends one, 'once' is a one-off,
// 'gap' marks a restart or monitoring gap, and null is not about incidents.
function incidentRole(key, event) {
  if (key === 'boot' || key === 'monitor') return 'gap';
  // The Agent pipeline panel owns jobs; pause/resume is a choice, not an incident.
  if (!key || key.startsWith('agent-job:') || key === 'agent-pipeline') return null;
  if (['agent-pump', 'oom', 'link'].includes(key) || key.startsWith('agent-process:')) return event.level === 'info' ? null : 'once';
  if (key === 'backup') return event.title === 'T7 backup failed' ? 'open' : event.title === 'T7 backup completed successfully' ? 'close' : null;
  // A service that restarted shares its key (the unit) with that service's state changes.
  if (event.level !== 'info' && / restarted$/.test(event.title)) return 'once';
  return event.level === 'info' ? 'close' : 'open';
}

/**
 * Groups retained events into incidents (episodes), newest first with active ones on top. Rules:
 * - A warning or critical event opens an episode for its key (internet, network, memory, a service unit,
 *   an HTTP check, a disk, auto-update, the auto-update and agent pump timers), or adds to the open one.
 *   The next info event for that key (restored, recovered, running, storage available, active again) ends it.
 *   The recorder writes a memory recovery only after MEMORY_SETTLE_MS (5 minutes) of healthy readings and
 *   dates it to the first of them, so a flapping memory level stays one episode.
 * - `T7 backup failed` opens a backup episode, and only `T7 backup completed successfully` ends it.
 * - One-offs are single-event episodes in state 'once', never active: a service restart, an OOM kill, link
 *   drops, a stopped or zombie workflow process, and a failed pump (which records no recovery).
 * - Not incidents: job events (the Agent pipeline panel owns them), pause/resume, backup starts and
 *   successes with nothing to end, and the `boot`/`monitor` markers.
 * - A `boot` or `monitor` event after an episode starts and no later than its end adds a caveat: the
 *   recovery may only have been seen after the computer or monitoring came back. No cause is implied.
 * - A recovery that is the oldest retained event for its key ends an episode whose start was pruned:
 *   it is 'recovered' with startedAt null. `Network connected or changed` is skipped there, because it
 *   also records a switch between two networks.
 */
export function incidentEpisodes(events, now) {
  const chronological = events
    .filter((e) => e && Number.isFinite(e.timestamp) && e.timestamp <= now)
    .map((event, index) => ({ event, index }))
    // Oldest first; events from one reading share a timestamp and keep their recorded order.
    .sort((a, b) => a.event.timestamp - b.event.timestamp || a.index - b.index)
    .map(({ event }) => event);
  const episodes = [], open = new Map(), seen = new Set(), gaps = [];
  const worst = (a, b) => ((LEVEL_RANK[b] ?? 0) > (LEVEL_RANK[a] ?? 0) ? b : a);
  for (const event of chronological) {
    const key = keyOf(event), role = incidentRole(key, event);
    if (role === 'gap') gaps.push(event);
    if (!role || role === 'gap') continue;
    const first = !seen.has(key);
    seen.add(key);
    if (role === 'once') {
      episodes.push({ key, title: event.title, level: event.level, startedAt: event.timestamp, endedAt: event.timestamp, state: 'once', eventCount: 1, caveats: [], lastAt: event.timestamp });
    } else if (role === 'open') {
      const episode = open.get(key);
      if (episode) Object.assign(episode, { level: worst(episode.level, event.level), eventCount: episode.eventCount + 1, lastAt: event.timestamp });
      else {
        const created = { key, title: event.title, level: event.level, startedAt: event.timestamp, endedAt: null, state: 'active', eventCount: 1, caveats: [], lastAt: event.timestamp };
        open.set(key, created);
        episodes.push(created);
      }
    } else {
      const episode = open.get(key);
      if (episode) {
        Object.assign(episode, { endedAt: event.timestamp, state: 'recovered', eventCount: episode.eventCount + 1, lastAt: event.timestamp });
        open.delete(key);
      } else if (first && key !== 'network' && key !== 'backup') {
        episodes.push({ key, title: event.title, level: event.level, startedAt: null, endedAt: event.timestamp, state: 'recovered', eventCount: 1, caveats: ['Start not retained; it is older than the kept history'], lastAt: event.timestamp });
      }
    }
  }
  for (const episode of episodes) {
    if (episode.state === 'once' || episode.startedAt == null) continue;
    const end = episode.endedAt ?? now, inside = gaps.filter((g) => g.timestamp > episode.startedAt && g.timestamp <= end);
    if (inside.some((g) => keyOf(g) === 'boot')) episode.caveats.push('Computer restarted during this incident; the recovery may only have been seen once it was back');
    if (inside.some((g) => keyOf(g) === 'monitor')) episode.caveats.push('Monitoring restarted during this incident; the recovery may only have been seen once it resumed');
  }
  const rank = (e) => (e.state === 'active' ? 1 : 0);
  return episodes.sort((a, b) => rank(b) - rank(a) || b.lastAt - a.lastAt).map(({ lastAt, ...episode }) => episode);
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
      // Replaced below once there is a previous reading to compare with.
      memoryRecorded: memoryLevel(snapshot), memoryHealthySince: null,
    };
    const workflow = diagnostics.agentWorkflow;
    if (workflow) {
      current.workflow = {
        pumpState: workflow.pumpState === 'unknown' ? previous?.workflow?.pumpState : workflow.pumpState,
        paused: workflow.paused ?? previous?.workflow?.paused,
        timerActive: workflow.timerActive ?? previous?.workflow?.timerActive,
        processes: workflow.available ? Object.fromEntries(workflow.processes.map((p) => [p.id, { pid: p.pid, name: p.name, state: p.state, reported: false }])) : previous?.workflow?.processes,
        jobs: workflow.jobsAvailable && !workflow.partial ? Object.fromEntries([...workflow.activeJobs, ...workflow.recentJobs].map((j) => [j.id, { status: j.status, stale: j.stale }])) : previous?.workflow?.jobs,
      };
      const before = previous?.workflow, after = current.workflow;
      if (before) {
        if (after.pumpState === 'failed' && before.pumpState !== 'failed') add('agent-pump', 'Agent pipeline pump failed', 'critical');
        if (typeof before.paused === 'boolean' && after.paused !== before.paused) add('agent-pipeline', after.paused ? 'Agent pipeline paused' : 'Agent pipeline resumed');
        if (typeof before.timerActive === 'boolean' && after.timerActive !== before.timerActive) add('agent-timer', after.timerActive ? 'Agent pump timer enabled' : 'Agent pump timer inactive', after.timerActive ? 'info' : 'warning');
        if (workflow.available && before.processes) {
          // Pipeline subprocesses come and go every minute and the live list is already on the page,
          // so only a process that stays stopped or zombie for two readings in a row is worth an event:
          // headless browser children are often seen as zombies once, just before they are reaped.
          for (const [id, process] of Object.entries(after.processes)) {
            const old = before.processes[id];
            if (!old || !STOPPED_STATES.includes(process.state) || !STOPPED_STATES.includes(old.state)) continue;
            // Older builds did not store `reported`; they recorded a process as soon as it stopped.
            if (old.reported ?? true) process.reported = true;
            else {
              add(`agent-process:${id}`, `Workflow process stopped or zombie: ${process.name} (#${process.pid})`, 'warning');
              process.reported = true;
            }
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
      // The recorded memory condition (`memoryRecorded`: the worst level of the open incident, or healthy or
      // unknown) is kept apart from the live level, so a level flipping between readings stays one incident.
      // `memoryHealthySince` is the first healthy reading of a settle time in progress. Files from older
      // builds have neither, so the last live level stands in for the recorded condition the first time.
      let memoryRecorded = previous.memoryRecorded ?? previous.memory ?? 'unknown', memoryHealthySince = previous.memoryHealthySince ?? null;
      if (isPressure(current.memory)) {
        if (!isPressure(memoryRecorded) || (current.memory === 'critical' && memoryRecorded !== 'critical')) {
          add('memory', 'Memory pressure elevated or available RAM low', current.memory);
          memoryRecorded = current.memory;
        }
        memoryHealthySince = null;
      } else if (current.memory === 'healthy') {
        if (!isPressure(memoryRecorded)) memoryRecorded = 'healthy';
        else {
          memoryHealthySince ??= now;
          if (now - memoryHealthySince >= MEMORY_SETTLE_MS) {
            add('memory', 'Memory pressure recovered', 'info', memoryHealthySince);
            memoryRecorded = 'healthy';
            memoryHealthySince = null;
          }
        }
      }
      // An unknown reading changes nothing: it neither ends the settle time nor opens a new incident.
      Object.assign(current, { memoryRecorded, memoryHealthySince });
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
    return { events: [...events], episodes: incidentEpisodes(events, now), samples: [...samples], lastSuccessAt, startedAt, persisted };
  };
}
