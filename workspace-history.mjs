import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function memoryLevel(snapshot) {
  const availablePct = snapshot.memory ? 100 - snapshot.memory.usedPct : null;
  const pressure = snapshot.diagnostics?.pressure.memory;
  if ((availablePct != null && availablePct <= 5) || pressure?.full?.avg10 >= 10) return 'critical';
  if ((availablePct != null && availablePct <= 10) || pressure?.some?.avg10 >= 10 || pressure?.full?.avg10 >= 1) return 'warning';
  return snapshot.memory || pressure ? 'healthy' : 'unknown';
}

// Seven days of incident events on this machine. Live, after #47, #52 and #54 grouped process churn, memory
// flips and per-reading link drops, it still records about 90 a day (2026-11-19: 38 events in 10 hours; the
// 100-event history then covered only 31 hours). Seven days at that rate is about 630; 1000 leaves room for an
// average of about 140 a day, so a bad day or two still fit. Routine agent activity has its own budget below.
export const MAX_EVENTS = 1000, MAX_ROUTINE_EVENTS = 20, EVENT_RETENTION_MS = 7 * 86400_000;

// The cap of builds before MAX_EVENTS was raised. A file from one of them holding this many incident events
// had dropped older ones to stay within it.
const LEGACY_MAX_EVENTS = 100;

// /api/workspace is polled every 30 seconds from a phone, so it serves only the newest events and episodes the
// page renders (10 of each), with room to spare, plus the true totals. Every active episode is always served.
export const API_EVENTS = 20, API_EPISODES = 20;

// The history file holds every event, so it is rewritten only when the events change, and at least this often
// so it never falls far behind. Each reading's state and latency samples go to a small companion file.
export const FULL_WRITE_MS = 10 * 60_000;

// Memory pressure counts as recovered only after readings have stayed healthy this long. On a busy machine
// the level flips every 30 seconds to 2 minutes, and each flip would otherwise be its own incident.
export const MEMORY_SETTLE_MS = 5 * 60_000;

// A Wi-Fi link that keeps dropping counts as steady again only after this long without a new drop. Live, drops
// come in bursts 30 seconds to 2 minutes apart, separated by quiet hours; each burst is one incident.
export const LINK_SETTLE_MS = 15 * 60_000;

// The most entries an episode's `events` list carries, so /api/workspace has a hard bound per episode.
export const MAX_EPISODE_EVENTS = 20;

// A dashboard restart that left at least this long without readings records a `monitor` marker, so an incident
// spanning it gets its caveat. Quicker restarts, such as an auto-update, miss a reading or two and record nothing.
export const MONITOR_GAP_MS = 2 * 60_000;

const STOPPED_STATES = ['Z', 'T', 't'];
const isPressure = (level) => level === 'warning' || level === 'critical';
// Older builds recorded each rise of the link-drop counter as its own event.
const isLegacyLinkDrop = (event) => /^Network link dropped \d+ time\(s\) between readings$/.test(event.title);

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
  return pruneWithDrops(events, now).events;
}

// pruneEvents(), plus `droppedAt`: the newest event younger than seven days that the MAX_EVENTS cap dropped,
// or null if it dropped none. Routine activity dropped from its own budget does not count.
function pruneWithDrops(events, now) {
  const recent = events
    .filter((e) => e && Number.isFinite(e.timestamp) && e.timestamp >= now - EVENT_RETENTION_MS && e.timestamp <= now && !isProcessChurn(e))
    .sort((a, b) => b.timestamp - a.timestamp);
  const incidents = recent.filter((e) => !isRoutineEvent(e)), main = incidents.slice(0, MAX_EVENTS);
  const routine = recent.filter(isRoutineEvent).slice(0, Math.min(MAX_ROUTINE_EVENTS, MAX_EVENTS - main.length));
  return { events: [...main, ...routine].sort((a, b) => b.timestamp - a.timestamp), droppedAt: incidents[MAX_EVENTS]?.timestamp ?? null };
}

/**
 * How far back the kept history goes. `oldestAt` is the start of the span the history is complete for: when
 * monitoring started, or seven days ago, whichever is later. If the MAX_EVENTS cap dropped an event from the
 * last seven days (`droppedAt`), the span starts at the oldest kept incident event instead and `trimmed` is true.
 */
export function historySpan({ events, startedAt, droppedAt }, now) {
  const trimmed = Number.isFinite(droppedAt) && droppedAt >= now - EVENT_RETENTION_MS;
  const incidents = events.filter((e) => !isRoutineEvent(e));
  const oldestAt = trimmed && incidents.length ? incidents.at(-1).timestamp : Math.max(startedAt ?? now, now - EVENT_RETENTION_MS);
  return { oldestAt, trimmed };
}

/**
 * What /api/workspace serves from a record() result: the newest API_EVENTS events with `eventCount`, and every
 * active episode plus the newest others up to API_EPISODES in all, with `episodeCount`. Episodes are paired
 * from the full history before this, so trimming the response changes no episode. `eventLimit` is MAX_EVENTS,
 * for saying what the cap is when it dropped older events.
 */
export function historyForApi(history) {
  const active = history.episodes.filter((e) => e.state === 'active').length;
  return {
    ...history,
    events: history.events.slice(0, API_EVENTS), eventCount: history.events.length, eventLimit: MAX_EVENTS,
    episodes: history.episodes.slice(0, Math.max(API_EPISODES, active)), episodeCount: history.episodes.length,
  };
}

// The companion file holding each reading's state between full writes.
export const stateFileOf = (file) => `${file.replace(/\.json$/, '')}.state.json`;

/**
 * Reads a saved history: the full file, with the companion file's `previous` and `samples` when they are from a
 * later reading. A file without a reading time (from an older build) is trusted over any companion file.
 * Returns null when there is no readable version-1 history.
 */
export async function readHistoryFile(file) {
  const read = (name) => readFile(name, 'utf8').then(JSON.parse).catch(() => null);
  const stored = await read(file);
  if (stored?.version !== 1) return null;
  const state = await read(stateFileOf(file));
  const newer = state?.version === 1 && Number.isFinite(state.previous?.readAt) && state.previous.readAt > (stored.previous?.readAt ?? Infinity);
  return newer ? { ...stored, previous: state.previous, samples: state.samples } : stored;
}

async function writeAtomic(file, text) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, text, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return true;
  } catch {
    await unlink(`${file}.tmp`).catch(() => {});
    return false;
  }
}

const LEVEL_RANK = { info: 0, warning: 1, critical: 2 };

// How an event takes part in incidents: 'open' starts or extends one, 'close' ends one, 'once' is a one-off,
// 'gap' marks a restart or monitoring gap, and null is not about incidents.
function incidentRole(key, event) {
  if (key === 'boot' || key === 'monitor') return 'gap';
  // The Agent pipeline panel owns jobs; pause/resume is a choice, not an incident.
  if (!key || key.startsWith('agent-job:') || key === 'agent-pipeline') return null;
  if (key === 'link' && isLegacyLinkDrop(event)) return 'once';
  if (['agent-pump', 'oom'].includes(key) || key.startsWith('agent-process:')) return event.level === 'info' ? null : 'once';
  if (key === 'backup') return event.title === 'T7 backup failed' ? 'open' : event.title === 'T7 backup completed successfully' ? 'close' : null;
  // A service that restarted shares its key (the unit) with that service's state changes.
  if (event.level !== 'info' && / restarted$/.test(event.title)) return 'once';
  return event.level === 'info' ? 'close' : 'open';
}

// Bounds an episode's evidence at MAX_EPISODE_EVENTS entries. Over the cap it keeps the first entry (what
// opened it), the newest (usually what ended it), then the restart and monitoring gaps behind its caveats,
// then the newest of the rest. `omittedEvents` counts the dropped non-gap events, so an episode's eventCount
// equals its non-gap entries plus omittedEvents.
function capEpisodeEvents(events) {
  if (events.length <= MAX_EPISODE_EVENTS) return { events };
  const keep = new Set([events[0], events.at(-1)]);
  const newestFirst = events.slice(1, -1).reverse();
  for (const e of [...newestFirst.filter((e) => e.gap), ...newestFirst.filter((e) => !e.gap)]) {
    if (keep.size >= MAX_EPISODE_EVENTS) break;
    keep.add(e);
  }
  return { events: events.filter((e) => keep.has(e)), omittedEvents: events.filter((e) => !keep.has(e) && !e.gap).length };
}

/**
 * Groups retained events into incidents (episodes), newest first with active ones on top. Rules:
 * - A warning or critical event opens an episode for its key (internet, network, memory, a service unit,
 *   an HTTP check, a disk, auto-update, the auto-update and agent pump timers), or adds to the open one.
 *   The next info event for that key (restored, recovered, running, storage available, active again) ends it.
 *   The recorder writes a memory recovery only after MEMORY_SETTLE_MS (5 minutes) of healthy readings and
 *   dates it to the first of them, so a flapping memory level stays one episode. Link drops work the same
 *   way: the first drop of a burst opens a link episode, and the recorder ends it after LINK_SETTLE_MS
 *   (15 minutes) without a new drop, dated to the first reading after the last drop.
 * - `T7 backup failed` opens a backup episode, and only `T7 backup completed successfully` ends it.
 * - One-offs are single-event episodes in state 'once', never active: a service restart, an OOM kill, link
 *   drops recorded per reading by older builds, a stopped or zombie workflow process, and a failed pump
 *   (which records no recovery).
 * - Not incidents: job events (the Agent pipeline panel owns them), pause/resume, backup starts and
 *   successes with nothing to end, and the `boot`/`monitor` markers.
 * - A `boot` or `monitor` event after an episode starts and no later than its end adds a caveat: the
 *   recovery may only have been seen after the computer or monitoring came back. No cause is implied.
 *   The recorder writes `monitor` when monitoring first starts, and when the dashboard restarts with its
 *   saved history after at least MONITOR_GAP_MS (2 minutes) without readings.
 * - A recovery that is the oldest retained event for its key ends an episode whose start was pruned:
 *   it is 'recovered' with startedAt null. `Network connected or changed` is skipped there, because it
 *   also records a switch between two networks.
 * Each episode but a one-off (whose row is its only event) lists its evidence in `events`, oldest first: `{ timestamp, level, title }` for every retained
 * event that opened, extended or ended it, plus the `boot`/`monitor` events behind a caveat, marked
 * `gap: true` with their `key`. See capEpisodeEvents() for the bound.
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
  const entry = (event) => ({ timestamp: event.timestamp, level: event.level, title: event.title });
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
      if (episode) {
        Object.assign(episode, { level: worst(episode.level, event.level), eventCount: episode.eventCount + 1, lastAt: event.timestamp });
        episode.events.push(entry(event));
      } else {
        const created = { key, title: event.title, level: event.level, startedAt: event.timestamp, endedAt: null, state: 'active', eventCount: 1, caveats: [], events: [entry(event)], lastAt: event.timestamp };
        open.set(key, created);
        episodes.push(created);
      }
    } else {
      const episode = open.get(key);
      if (episode) {
        Object.assign(episode, { endedAt: event.timestamp, state: 'recovered', eventCount: episode.eventCount + 1, lastAt: event.timestamp });
        episode.events.push(entry(event));
        open.delete(key);
      } else if (first && key !== 'network' && key !== 'backup') {
        episodes.push({ key, title: event.title, level: event.level, startedAt: null, endedAt: event.timestamp, state: 'recovered', eventCount: 1, caveats: ['Start not retained; it is older than the kept history'], events: [entry(event)], lastAt: event.timestamp });
      }
    }
  }
  for (const episode of episodes) {
    if (episode.state === 'once' || episode.startedAt == null) continue;
    const end = episode.endedAt ?? now, inside = gaps.filter((g) => g.timestamp > episode.startedAt && g.timestamp <= end);
    if (inside.some((g) => keyOf(g) === 'boot')) episode.caveats.push('Computer restarted during this incident; the recovery may only have been seen once it was back');
    if (inside.some((g) => keyOf(g) === 'monitor')) episode.caveats.push('Monitoring restarted during this incident; the recovery may only have been seen once it resumed');
    if (!inside.length) continue;
    // Both lists are oldest first; a gap in the same reading as an event goes after it, as the recorder adds it later.
    const merged = [...episode.events, ...inside.map((g) => ({ ...entry(g), gap: true, key: keyOf(g) }))];
    episode.events = merged.map((e, i) => ({ e, i })).sort((a, b) => a.e.timestamp - b.e.timestamp || a.i - b.i).map(({ e }) => e);
  }
  for (const episode of episodes) if (episode.events) Object.assign(episode, capEpisodeEvents(episode.events));
  const rank = (e) => (e.state === 'active' ? 1 : 0);
  return episodes.sort((a, b) => rank(b) - rank(a) || b.lastAt - a.lastAt).map(({ lastAt, ...episode }) => episode);
}

export function createWorkspaceHistory({ file = null } = {}) {
  let loaded = false, resumed = false, events = [], samples = [], previous = null, lastSuccessAt = null, startedAt = null, droppedAt = null;
  // The events as last written to the full file, and when; null until this process has written it.
  let writtenEvents = null, writtenAt = null;
  return async function record(snapshot) {
    if (!loaded) {
      loaded = true;
      const stored = file ? await readHistoryFile(file) : null;
      if (stored) {
        events = Array.isArray(stored.events) ? stored.events : [];
        samples = Array.isArray(stored.samples) ? stored.samples : [];
        previous = stored.previous || null;
        resumed = previous != null;
        lastSuccessAt = stored.lastSuccessAt || null;
        startedAt = stored.startedAt || null;
        if (Object.hasOwn(stored, 'droppedAt')) droppedAt = Number.isFinite(stored.droppedAt) ? stored.droppedAt : null;
        else {
          // Older builds kept no record of what their cap dropped; one full at its cap had dropped older events.
          const incidents = events.filter((e) => e && Number.isFinite(e.timestamp) && !isRoutineEvent(e)).map((e) => e.timestamp);
          if (incidents.length >= LEGACY_MAX_EVENTS) droppedAt = Math.min(...incidents) - 1;
        }
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
      readAt: now, uptimeSec: snapshot.uptimeSec, internet: snapshot.internet.state, network: snapshot.internet.networkName,
      // An unreadable counter keeps the last known value, so drops during the gap are counted once it is back.
      // The counter belongs to one network device, so a network change drops the old baseline.
      disconnections: snapshot.internet.disconnections ?? (previous?.network === snapshot.internet.networkName ? previous?.disconnections : null) ?? null, memory: memoryLevel(snapshot), oomKills: diagnostics.oomKills,
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
      const rebooted = current.uptimeSec < previous.uptimeSec;
      if (rebooted) add('boot', 'Computer restarted');
      // The first reading after the dashboard restarted with saved history. Files from older builds have no
      // reading time, so their newest latency sample (taken with that reading) stands in; with neither, the gap
      // is unknown and nothing is recorded. A computer restart already has its own marker.
      const lastReadAt = resumed ? previous.readAt ?? samples.at(-1)?.timestamp : null;
      if (!rebooted && Number.isFinite(lastReadAt) && now - lastReadAt >= MONITOR_GAP_MS) {
        const minutes = Math.round((now - lastReadAt) / 60_000);
        add('monitor', `Computer monitoring resumed after ${minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`} without readings`);
      }
      if (current.internet !== previous.internet) add('internet', `Internet ${current.internet === 'online' ? 'connection restored' : `became ${current.internet}`}`, current.internet === 'online' ? 'info' : 'warning');
      if (current.network !== previous.network) add('network', current.network ? 'Network connected or changed' : 'Network disconnected', current.network ? 'info' : 'warning');
      // Link drops are one incident per burst. `link` is the open incident: its drop count, the reading that saw
      // the last drop, and the first reading after it (null until there is one). Files from older builds have
      // none, so they start without an open incident. A network change is recorded by its own event, not as drops.
      let link = previous.link ? { ...previous.link } : null;
      const live = snapshot.internet.disconnections;
      // A counter can be compared with the last one only on the same network, and only if it did not go down.
      const comparable = live != null && previous.disconnections != null && current.network === previous.network && live >= previous.disconnections;
      const drops = comparable ? live - previous.disconnections : 0;
      const plural = (n) => `${n} drop${n === 1 ? '' : 's'}`;
      if (drops > 0) {
        // Drops seen after a gap in readings may have happened at any time in it, so they continue the open
        // incident: only a comparable, unchanged counter confirms that the link has been steady.
        if (link) Object.assign(link, { drops: link.drops + drops, lastDropAt: now, steadySince: null });
        else {
          add('link', `Network link unstable: dropped ${drops} time(s)`, 'warning');
          link = { drops, lastDropAt: now, steadySince: null };
        }
      } else if (link && live != null && !comparable) {
        // A counter that went down (reboot, interface reset), a new network or a missing baseline re-baselines
        // without a drop. It cannot confirm the time since the last reading was steady, so the settle time
        // starts again from this reading.
        Object.assign(link, { rebaselinedAt: now, steadySince: null });
      } else if (link && comparable) {
        // An unreadable counter neither extends nor ends the incident.
        link.steadySince ??= now;
        if (now - Math.max(link.lastDropAt, link.rebaselinedAt ?? -Infinity) >= LINK_SETTLE_MS) {
          add('link', `Network link steady again after ${plural(link.drops)}`, 'info', link.steadySince);
          link = null;
        }
      }
      current.link = link;
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
    const pruned = pruneWithDrops(events, now);
    events = pruned.events;
    if (pruned.droppedAt != null) droppedAt = Math.max(droppedAt ?? -Infinity, pruned.droppedAt);
    previous = current;
    resumed = false;
    let persisted = null;
    if (file) {
      // A full write carries everything, so an older build can still read the file. Between full writes, only
      // the reading's state and samples change, and they go to the companion file. A failed full write is retried
      // on the next reading, and until one works the companion file is not written either, so the saved state
      // never gets ahead of the saved events: after a restart, the changes are compared and recorded again.
      const eventsJson = JSON.stringify(events);
      if (eventsJson !== writtenEvents || now - writtenAt >= FULL_WRITE_MS || now < writtenAt) {
        persisted = await writeAtomic(file, `{"version":1,"events":${eventsJson},${JSON.stringify({ samples, previous, lastSuccessAt, startedAt, droppedAt }).slice(1)}`);
        if (persisted) [writtenEvents, writtenAt] = [eventsJson, now];
      } else persisted = await writeAtomic(stateFileOf(file), JSON.stringify({ version: 1, samples, previous }));
    }
    return { events: [...events], episodes: incidentEpisodes(events, now), samples: [...samples], lastSuccessAt, startedAt, persisted, ...historySpan({ events, startedAt, droppedAt }, now) };
  };
}
