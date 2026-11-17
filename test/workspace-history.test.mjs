import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceHistory, incidentEpisodes, isRoutineEvent, pruneEvents, MAX_EVENTS, MAX_ROUTINE_EVENTS, MEMORY_SETTLE_MS } from '../workspace-history.mjs';

const DAY = 86400_000, START = 1_800_000_000_000;

function snapshot(now) {
  return { generatedAt: now, uptimeSec: 1000, memory: { usedPct: 50 }, internet: { state: 'online', networkName: 'Wi-Fi', latencyMs: 50, disconnections: 1 },
    services: [{ unit: 't3code.service', name: 'T3 Code', state: 'running', automaticRestarts: 0, startedAt: 100 }],
    diagnostics: { pressure: { memory: { some: { avg10: 0 }, full: { avg10: 0 } } }, oomKills: 0, healthChecks: [], disks: [],
      backup: { state: 'unknown' },
      agentWorkflow: { available: true, processes: [], jobsAvailable: true, partial: false, activeJobs: [], recentJobs: [], pumpState: 'idle', paused: false, timerActive: true } } };
}

async function tempFile(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'workspace-history.json');
}

function assertWellFormed(events, now) {
  assert.ok(events.length <= MAX_EVENTS, `${events.length} events`);
  assert.ok(events.filter(isRoutineEvent).length <= MAX_ROUTINE_EVENTS);
  for (const e of events) assert.ok(e.timestamp >= now - 7 * DAY && e.timestamp <= now);
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].timestamp >= events[i].timestamp, 'newest first');
}

test('workflow processes appearing or disappearing record nothing, but a process stopped or zombie for two readings warns once', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START), w = s.diagnostics.agentWorkflow;
  const processEvents = (result) => result.events.filter((e) => e.id.includes(':agent-process:')).map((e) => [e.title, e.level, e.timestamp]);
  await record(s);
  s.generatedAt += 30_000;
  w.processes = [{ id: '10:1', pid: 10, name: 'gh', state: 'S' }, { id: '11:1', pid: 11, name: 'bun', state: 'S' }, { id: '13:1', pid: 13, name: 'chrome-headless', state: 'S' }];
  assert.deepEqual(processEvents(await record(s)), []);
  // One zombie reading, then reaped: nothing is recorded.
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'Z' }, { id: '12:1', pid: 12, name: 'git', state: 'S' }, { id: '13:1', pid: 13, name: 'chrome-headless', state: 'Z' }];
  assert.deepEqual(processEvents(await record(s)), []);
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'Z' }];
  const second = s.generatedAt;
  assert.deepEqual(processEvents(await record(s)), [['Workflow process stopped or zombie: bun (#11)', 'warning', second]]);
  // Still a zombie, or now stopped instead: the same stretch, so no second event.
  s.generatedAt += 30_000;
  assert.equal(processEvents(await record(s)).length, 1);
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'T' }];
  assert.equal(processEvents(await record(s)).length, 1);
  // Running again and then a zombie for two readings is a new stretch.
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'S' }];
  await record(s);
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'Z' }];
  await record(s);
  s.generatedAt += 30_000;
  assert.equal(processEvents(await record(s)).length, 2);
  s.generatedAt += 30_000;
  w.processes = [];
  assert.equal(processEvents(await record(s)).length, 2);
});

test('a day-one service failure and recovery survive seven days of routine job status changes', async (t) => {
  const file = await tempFile(t), record = createWorkspaceHistory({ file });
  const s = snapshot(START), w = s.diagnostics.agentWorkflow;
  await record(s);
  s.generatedAt += 60_000;
  s.services[0].state = 'failed';
  await record(s);
  s.generatedAt += 60_000;
  s.services[0].state = 'running';
  await record(s);
  // Every 15 minutes for a week a job launches, runs and finishes: ~2000 info-level status changes.
  let job = 0, result;
  const end = START + 7 * DAY - 10 * 60_000;
  while (s.generatedAt + 15 * 60_000 < end) {
    s.generatedAt += 5 * 60_000;
    const id = `job-${++job}`;
    w.activeJobs = [{ id, status: 'running', stale: false }];
    await record(s);
    s.generatedAt += 5 * 60_000;
    w.activeJobs = []; w.recentJobs = [{ id, status: 'done', stale: false }];
    await record(s);
    s.generatedAt += 5 * 60_000;
    result = await record(s);
  }
  assert.ok(job > 600);
  assert.ok(result.events.some((e) => e.title === 'T3 Code: failed' && e.level === 'warning'));
  assert.ok(result.events.some((e) => e.title === 'T3 Code: running'));
  assert.ok(result.events.some((e) => e.title === 'Computer monitoring started'));
  const routine = result.events.filter(isRoutineEvent);
  assert.equal(routine.length, MAX_ROUTINE_EVENTS);
  // The newest job changes are the ones kept.
  assert.equal(routine[0].title, `Workflow job job-${job}: done`);
  assertWellFormed(result.events, s.generatedAt);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.events, result.events);
});

test('warning and critical agent events use the main budget, not the routine one', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START), w = s.diagnostics.agentWorkflow;
  await record(s);
  s.generatedAt += 30_000;
  w.pumpState = 'failed';
  w.activeJobs = [{ id: 'job-bad', status: 'running', stale: true }, { id: 'job-blocked', status: 'launched', stale: false }, { id: 'job-stalled', status: 'running', stale: false }];
  await record(s);
  s.generatedAt += 30_000;
  w.activeJobs = [{ id: 'job-blocked', status: 'blocked', stale: false }, { id: 'job-stalled', status: 'stalled', stale: false }];
  w.recentJobs = [{ id: 'job-bad', status: 'failed', stale: false }];
  await record(s);
  // Then a flood of routine activity.
  let result;
  for (let i = 0; i < 200; i++) {
    s.generatedAt += 30_000;
    w.activeJobs = [{ id: `job-${i}`, status: 'running', stale: false }];
    w.recentJobs = [];
    w.paused = i % 2 === 0;
    result = await record(s);
  }
  for (const title of ['Agent pipeline pump failed', 'Workflow job heartbeat overdue: job-bad', 'Workflow job job-bad: failed', 'Workflow job job-blocked: blocked', 'Workflow job job-stalled: stalled']) {
    const event = result.events.find((e) => e.title === title);
    assert.ok(event, title);
    assert.ok(!isRoutineEvent(event), title);
  }
  assert.equal(result.events.filter(isRoutineEvent).length, MAX_ROUTINE_EVENTS);
  assertWellFormed(result.events, s.generatedAt);
});

test('pruning caps the total at 100 and lets routine activity fill only what is left', () => {
  const now = START;
  const event = (i, key, level = 'info') => ({ id: `${now - i * 1000}:${key}:Event ${i}`, timestamp: now - i * 1000, level, title: `Event ${i}` });
  const routine = Array.from({ length: 50 }, (_, i) => event(i, `agent-job:job-${i}`));
  const other = Array.from({ length: 150 }, (_, i) => event(100 + i, 'internet', 'warning'));
  const full = pruneEvents([...routine, ...other], now);
  assert.equal(full.length, MAX_EVENTS);
  assert.equal(full.filter(isRoutineEvent).length, 0);
  const some = pruneEvents([...routine, ...other.slice(0, 90)], now);
  assert.equal(some.length, MAX_EVENTS);
  assert.equal(some.filter(isRoutineEvent).length, 10);
  assert.deepEqual(some.filter(isRoutineEvent).map((e) => e.title), routine.slice(0, 10).map((e) => e.title));
  const old = pruneEvents([event(-5, 'boot'), { ...event(0, 'boot'), timestamp: now - 8 * DAY, id: `${now - 8 * DAY}:boot:Old` }, event(1, 'boot')], now);
  assert.deepEqual(old.map((e) => e.title), ['Event 1']);
});

test('a stored history flooded with process starts and exits is pruned on the next reading', async (t) => {
  const file = await tempFile(t), now = START;
  const events = [];
  for (let i = 0; i < 96; i++) {
    const timestamp = now - 60_000 - i * 40_000, kind = i % 2 ? 'exited' : 'started';
    events.push({ id: `${timestamp}:agent-process:${i}:1:Workflow process ${kind}: gh (#${i})`, timestamp, level: 'info', title: `Workflow process ${kind}: gh (#${i})` });
  }
  events.push({ id: `${now - 70_000}:agent-process:7:1:Workflow process stopped or zombie: bun (#7)`, timestamp: now - 70_000, level: 'warning', title: 'Workflow process stopped or zombie: bun (#7)' });
  events.push({ id: `${now - 2 * DAY}:backup:T7 backup completed successfully`, timestamp: now - 2 * DAY, level: 'info', title: 'T7 backup completed successfully' });
  events.push({ id: `${now - 3 * DAY}:link:Network link dropped 1 time(s) between readings`, timestamp: now - 3 * DAY, level: 'warning', title: 'Network link dropped 1 time(s) between readings' });
  events.push({ id: `${now - 4 * DAY}:agent-job:job-1:Workflow job job-1: done`, timestamp: now - 4 * DAY, level: 'info', title: 'Workflow job job-1: done' });
  const s = snapshot(now);
  await writeFile(file, JSON.stringify({ version: 1, events, samples: [], previous: null, lastSuccessAt: null, startedAt: now - 5 * DAY }));
  const result = await createWorkspaceHistory({ file })(s);
  assert.ok(!result.events.some((e) => /Workflow process (started|exited)/.test(e.title)));
  for (const title of ['Workflow process stopped or zombie: bun (#7)', 'T7 backup completed successfully', 'Network link dropped 1 time(s) between readings', 'Workflow job job-1: done']) {
    assert.ok(result.events.some((e) => e.title === title), title);
  }
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.events, result.events);
  for (const e of stored.events) assert.deepEqual(Object.keys(e).sort(), ['id', 'level', 'timestamp', 'title']);
  assert.equal(result.startedAt, now - 5 * DAY);
});

// ---------- Incidents ----------
// A reading with one HTTP check, one disk and the auto-updater, so every condition key can fail and recover.
function richSnapshot(now) {
  const s = snapshot(now);
  s.diagnostics.healthChecks = [{ id: 't3-local', service: 't3code.service', label: 'HTTP check', state: 'healthy' }];
  s.diagnostics.disks = [{ name: 'T7 drive', path: '/mnt/nas', mounted: true, readOnly: false, usedPct: 40 }];
  s.autoUpdate = { state: 'ok', timerActive: true, lastExitStatus: 0 };
  return s;
}
const MIN = 60_000;
const ev = (timestamp, key, title, level = 'info') => ({ id: `${timestamp}:${key}:${title}`, timestamp, level, title });
const byKey = (episodes, key) => episodes.filter((e) => e.key === key);

test('each condition the recorder emits pairs its failure and recovery into one recovered episode', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START), d = s.diagnostics;
  await record(s);
  const fail = START + MIN, recover = START + 5 * MIN;
  s.generatedAt = fail;
  s.internet.state = 'offline'; s.internet.networkName = null; s.memory.usedPct = 92;
  s.services[0].state = 'failed'; d.healthChecks[0].state = 'unhealthy'; d.disks[0].usedPct = 95;
  s.autoUpdate = { state: 'failed', timerActive: false, lastExitStatus: 1 }; d.agentWorkflow.timerActive = false;
  d.backup = { state: 'failed', finishedAt: fail };
  await record(s);
  s.generatedAt = recover;
  s.internet.state = 'online'; s.internet.networkName = 'Wi-Fi'; s.memory.usedPct = 50;
  s.services[0].state = 'running'; d.healthChecks[0].state = 'healthy'; d.disks[0].usedPct = 40;
  s.autoUpdate = { state: 'ok', timerActive: true, lastExitStatus: 0 }; d.agentWorkflow.timerActive = true;
  d.backup = { state: 'success', finishedAt: recover, lastSuccessAt: recover };
  await record(s);
  // Memory is recorded as recovered once it has stayed healthy for the settle time, dated to the first healthy reading.
  s.generatedAt = recover + MEMORY_SETTLE_MS;
  const { episodes, events } = await record(s);
  const keys = ['internet', 'network', 'memory', 't3code.service', 't3-local', '/mnt/nas', 'auto-update', 'auto-update-timer', 'agent-timer', 'backup'];
  assert.deepEqual(episodes.map((e) => e.key).sort(), [...keys].sort());
  for (const key of keys) {
    const [episode] = byKey(episodes, key);
    assert.equal(episode.state, 'recovered', key);
    assert.equal(episode.startedAt, fail, key);
    assert.equal(episode.endedAt, recover, key);
    assert.equal(episode.eventCount, 2, key);
    assert.deepEqual(episode.caveats, [], key);
  }
  assert.equal(byKey(episodes, 'internet')[0].title, 'Internet became offline');
  assert.equal(byKey(episodes, 't3-local')[0].title, 'T3 Code · HTTP check: response failed');
  assert.equal(byKey(episodes, 'backup')[0].level, 'critical');
  // The monitoring-started marker is not an incident, and the pruned events are what the episodes came from.
  assert.ok(events.some((e) => e.title === 'Computer monitoring started'));
});

test('a condition with no recovery yet is active, and repeated warnings while it is open form one episode', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START);
  await record(s);
  s.generatedAt += MIN; s.internet.state = 'offline';
  await record(s);
  s.generatedAt += MIN; s.internet.state = 'limited';
  await record(s);
  s.generatedAt += MIN; s.memory.usedPct = 92;
  await record(s);
  s.generatedAt += MIN; s.memory.usedPct = 97;
  const { episodes } = await record(s);
  const [internet] = byKey(episodes, 'internet'), [memory] = byKey(episodes, 'memory');
  assert.deepEqual([internet.state, internet.endedAt, internet.eventCount, internet.title, internet.startedAt], ['active', null, 2, 'Internet became offline', START + MIN]);
  assert.deepEqual([memory.state, memory.eventCount, memory.level], ['active', 2, 'critical']);
  // Active first, then by newest activity: memory changed last.
  assert.deepEqual(episodes.map((e) => e.key), ['memory', 'internet']);
});

test('restarts, OOM kills, link drops, zombie processes and pump failures are one-offs, never active', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START), w = s.diagnostics.agentWorkflow;
  await record(s);
  s.generatedAt += MIN;
  s.services[0].startedAt = 200; s.diagnostics.oomKills = 1; s.internet.disconnections = 3; w.pumpState = 'failed';
  w.processes = [{ id: '9:1', pid: 9, name: 'bun', state: 'S' }];
  await record(s);
  s.generatedAt += MIN;
  w.processes = [{ id: '9:1', pid: 9, name: 'bun', state: 'Z' }];
  await record(s);
  s.generatedAt += MIN;
  const { episodes } = await record(s);
  assert.deepEqual(episodes.map((e) => e.title).sort(), ['Agent pipeline pump failed', 'Linux killed a process because memory ran out', 'Network link dropped 2 time(s) between readings', 'T3 Code restarted', 'Workflow process stopped or zombie: bun (#9)']);
  for (const episode of episodes) {
    assert.equal(episode.state, 'once', episode.title);
    assert.equal(episode.endedAt, episode.startedAt, episode.title);
    assert.equal(episode.eventCount, 1);
  }
  // A one-off sharing the service's key does not open, or get closed by, a service condition.
  const mixed = incidentEpisodes([ev(START + 2 * MIN, 't3code.service', 'T3 Code: running'), ev(START + MIN, 't3code.service', 'T3 Code restarted', 'warning'), ev(START, 'monitor', 'Computer monitoring started')], START + 3 * MIN);
  assert.deepEqual(mixed.map((e) => [e.title, e.state]), [['T3 Code restarted', 'once']]);
});

test('a T7 backup failure ends only with a completed backup, not a started one', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START), d = s.diagnostics;
  await record(s);
  s.generatedAt += MIN; d.backup = { state: 'failed', finishedAt: s.generatedAt };
  await record(s);
  s.generatedAt += MIN; d.backup = { state: 'running', finishedAt: START + MIN };
  let { episodes } = await record(s);
  assert.deepEqual(episodes.map((e) => [e.title, e.state, e.endedAt]), [['T7 backup failed', 'active', null]]);
  s.generatedAt += MIN; d.backup = { state: 'success', finishedAt: s.generatedAt, lastSuccessAt: s.generatedAt };
  ({ episodes } = await record(s));
  assert.deepEqual(episodes.map((e) => [e.title, e.state, e.startedAt, e.endedAt, e.eventCount]), [['T7 backup failed', 'recovered', START + MIN, START + 3 * MIN, 2]]);
  // Backup successes and starts alone are routine.
  assert.deepEqual(incidentEpisodes([ev(START + MIN, 'backup', 'T7 backup started'), ev(START, 'backup', 'T7 backup completed successfully')], START + MIN), []);
});

test('a restart or monitoring gap inside an episode adds a caveat, and a pruned start is recovered with a note', () => {
  const now = START + 60 * MIN;
  const episodes = incidentEpisodes([
    ev(START + 50 * MIN, 'internet', 'Internet connection restored'),
    ev(START + 50 * MIN, 'boot', 'Computer restarted'),
    ev(START + 40 * MIN, 'internet', 'Internet became offline', 'warning'),
    ev(START + 30 * MIN, 'monitor', 'Computer monitoring started'),
    ev(START + 20 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'warning'),
    ev(START + 10 * MIN, 'boot', 'Computer restarted'),
    ev(START + 5 * MIN, 't3code.service', 'T3 Code: running'),
    ev(START + 4 * MIN, 'network', 'Network connected or changed'),
  ], now);
  const [memory] = byKey(episodes, 'memory'), [internet] = byKey(episodes, 'internet'), [service] = byKey(episodes, 't3code.service');
  // Memory opened after the first restart, so only the monitoring gap and the later restart fall inside it.
  assert.equal(memory.state, 'active');
  assert.equal(memory.caveats.length, 2);
  assert.match(memory.caveats.join(' '), /Computer restarted during this incident/);
  assert.match(memory.caveats.join(' '), /Monitoring restarted during this incident/);
  // A restart in the same reading as the recovery counts as inside the episode.
  assert.equal(internet.state, 'recovered');
  assert.deepEqual(internet.caveats.map((c) => c.split(';')[0]), ['Computer restarted during this incident']);
  assert.deepEqual([service.state, service.startedAt, service.endedAt, service.title], ['recovered', null, START + 5 * MIN, 'T3 Code: running']);
  assert.match(service.caveats[0], /Start not retained/);
  // A network change may be a switch between networks, not a recovery, so it does not make an episode.
  assert.deepEqual(byKey(episodes, 'network'), []);
  // A recovery that is not the oldest event for its key, with nothing open, is ignored.
  assert.deepEqual(incidentEpisodes([ev(START + 2 * MIN, 'memory', 'Memory pressure recovered'), ev(START + MIN, 'memory', 'Memory pressure recovered')], now).map((e) => e.endedAt), [START + MIN]);
});

test('job events, pause/resume and routine markers produce no episodes', () => {
  const now = START + 10 * MIN;
  const episodes = incidentEpisodes([
    ev(START + 6 * MIN, 'agent-job:job-1', 'Workflow job job-1: failed', 'warning'),
    ev(START + 5 * MIN, 'agent-job:job-1', 'Workflow job heartbeat overdue: job-1', 'warning'),
    ev(START + 4 * MIN, 'agent-job:job-1', 'Workflow job job-1: running'),
    ev(START + 3 * MIN, 'agent-pipeline', 'Agent pipeline resumed'),
    ev(START + 2 * MIN, 'agent-pipeline', 'Agent pipeline paused'),
    ev(START + MIN, 'boot', 'Computer restarted'),
    ev(START, 'monitor', 'Computer monitoring started'),
    { id: 'malformed', timestamp: START, level: 'warning', title: 'No key' },
    ev(now + MIN, 'internet', 'Internet became offline', 'warning'),
  ], now);
  assert.deepEqual(episodes, []);
});

test('the pump timer coming back is kept with the warning it ends, not dropped with routine job activity', () => {
  const now = START + 100 * MIN;
  const jobs = Array.from({ length: 40 }, (_, i) => ev(START + (50 + i) * MIN, `agent-job:job-${i}`, `Workflow job job-${i}: done`));
  const events = pruneEvents([ev(START + MIN, 'agent-timer', 'Agent pump timer inactive', 'warning'), ev(START + 2 * MIN, 'agent-timer', 'Agent pump timer enabled'), ...jobs], now);
  assert.ok(events.some((e) => e.title === 'Agent pump timer enabled'));
  assert.deepEqual(incidentEpisodes(events, now).map((e) => [e.key, e.state]), [['agent-timer', 'recovered']]);
});

test('a history file from the previous build loads unchanged and gains episodes in the API result', async (t) => {
  const file = await tempFile(t), now = START;
  const events = [
    ev(now - 2 * DAY + MIN, 't3code.service', 'T3 Code: running'),
    ev(now - 2 * DAY, 't3code.service', 'T3 Code: failed', 'warning'),
    ev(now - 3 * DAY, 'agent-job:job-1', 'Workflow job job-1: done'),
    ev(now - 4 * DAY, 'monitor', 'Computer monitoring started'),
  ];
  const s = snapshot(now);
  const previous = { uptimeSec: 900, internet: 'online', network: 'Wi-Fi', disconnections: 1, memory: 'healthy', oomKills: 0,
    services: { 't3code.service': { state: 'running', startedAt: 100, restarts: 0 } }, health: {}, disks: {}, backup: 'unknown', backupFinished: null };
  await writeFile(file, JSON.stringify({ version: 1, events, samples: [], previous, lastSuccessAt: null, startedAt: now - 4 * DAY }));
  const result = await createWorkspaceHistory({ file })(s);
  assert.deepEqual(result.episodes.map((e) => [e.title, e.state, e.startedAt, e.endedAt]), [['T3 Code: failed', 'recovered', now - 2 * DAY, now - 2 * DAY + MIN]]);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['events', 'lastSuccessAt', 'previous', 'samples', 'startedAt', 'version']);
  assert.deepEqual(stored.events, events);
});

// ---------- Memory settle time ----------
const SEC = 1000;
function setMemory(s, level) {
  if (level === 'unknown') { s.memory = null; s.diagnostics.pressure.memory = null; return s; }
  s.memory = { usedPct: { healthy: 50, warning: 92, critical: 97 }[level] };
  s.diagnostics.pressure.memory = { some: { avg10: 0 }, full: { avg10: 0 } };
  return s;
}
const memoryEvents = (result) => result.events.filter((e) => e.id.includes(':memory:')).map((e) => [e.title, e.level, e.timestamp]).reverse();
const OPENED = 'Memory pressure elevated or available RAM low', RECOVERED = 'Memory pressure recovered';

// Records one reading per [offset, level], offsets relative to START.
async function readings(record, s, steps) {
  let result;
  for (const [offset, level] of steps) {
    s.generatedAt = START + offset;
    result = await record(setMemory(s, level));
  }
  return result;
}

test('memory flapping with healthy gaps under the settle time is one incident, recovered at the first reading of the final healthy stretch', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  const steps = [[0, 'healthy']];
  let t = 30 * SEC;
  for (let i = 0; i < 20; i++) {
    steps.push([t, 'warning']); t += 30 * SEC;
    // Healthy for up to 4.5 minutes, never the full settle time.
    for (let j = 0; j <= i % 10; j++) { steps.push([t, 'healthy']); t += 30 * SEC; }
  }
  steps.push([t, 'warning']); t += 30 * SEC;
  const healthyFrom = t;
  for (; t <= healthyFrom + MEMORY_SETTLE_MS - 30 * SEC; t += 30 * SEC) steps.push([t, 'healthy']);
  let result = await readings(record, s, steps);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + 30 * SEC]]);
  // The reading that completes five healthy minutes records the recovery, dated to when pressure eased.
  result = await readings(record, s, [[healthyFrom + MEMORY_SETTLE_MS, 'healthy'], [healthyFrom + MEMORY_SETTLE_MS + 30 * SEC, 'healthy']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + 30 * SEC], [RECOVERED, 'info', START + healthyFrom]]);
  assert.deepEqual(byKey(result.episodes, 'memory').map((e) => [e.state, e.startedAt, e.endedAt, e.eventCount]), [['recovered', START + 30 * SEC, START + healthyFrom, 2]]);
});

test('memory escalating to critical while open is recorded once and keeps one critical episode', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  const result = await readings(record, s, [[0, 'healthy'], [30 * SEC, 'warning'], [60 * SEC, 'healthy'], [90 * SEC, 'critical'], [120 * SEC, 'warning'], [150 * SEC, 'critical'], [180 * SEC, 'warning']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + 30 * SEC], [OPENED, 'critical', START + 90 * SEC]]);
  assert.deepEqual(byKey(result.episodes, 'memory').map((e) => [e.state, e.level, e.eventCount]), [['active', 'critical', 2]]);
});

test('a healthy stretch that reaches the settle time recovers even if the next reading is a warning, which opens a new incident', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  const steps = [[0, 'healthy'], [MIN, 'warning']];
  for (let t = 2 * MIN; t <= 2 * MIN + MEMORY_SETTLE_MS; t += 30 * SEC) steps.push([t, 'healthy']);
  steps.push([2 * MIN + MEMORY_SETTLE_MS + 30 * SEC, 'warning']);
  const result = await readings(record, s, steps);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + MIN], [RECOVERED, 'info', START + 2 * MIN], [OPENED, 'warning', START + 2 * MIN + MEMORY_SETTLE_MS + 30 * SEC]]);
  assert.deepEqual(byKey(result.episodes, 'memory').map((e) => e.state), ['active', 'recovered']);
});

test('unknown memory readings neither finish the settle time nor start a new incident', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  let result = await readings(record, s, [[0, 'healthy'], [MIN, 'warning'], [2 * MIN, 'unknown'], [3 * MIN, 'warning'], [4 * MIN, 'healthy'],
    [5 * MIN, 'unknown'], [8 * MIN, 'unknown'], [10 * MIN, 'unknown']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + MIN]]);
  // The settle time that started at 4 minutes is still running and completes on the next healthy reading.
  result = await readings(record, s, [[10 * MIN + 30 * SEC, 'healthy']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + MIN], [RECOVERED, 'info', START + 4 * MIN]]);
  // After a recovery, unknown then warning opens exactly one new incident.
  result = await readings(record, s, [[11 * MIN, 'unknown'], [12 * MIN, 'warning'], [13 * MIN, 'unknown'], [14 * MIN, 'warning']]);
  assert.equal(memoryEvents(result).filter(([title]) => title === OPENED).length, 2);
});

test('the recorded memory condition and its settle time survive a restart', async (t) => {
  const file = await tempFile(t), s = snapshot(START);
  await readings(createWorkspaceHistory({ file }), s, [[0, 'healthy'], [MIN, 'warning'], [2 * MIN, 'healthy'], [3 * MIN, 'healthy']]);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([stored.previous.memory, stored.previous.memoryRecorded, stored.previous.memoryHealthySince], ['healthy', 'warning', START + 2 * MIN]);
  // A new recorder on the same file finishes the settle time without reopening the incident.
  const record = createWorkspaceHistory({ file });
  let result = await readings(record, s, [[5 * MIN, 'healthy']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + MIN]]);
  result = await readings(record, s, [[7 * MIN, 'healthy']]);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', START + MIN], [RECOVERED, 'info', START + 2 * MIN]]);
  // A restart while memory is still under pressure records no duplicate opening event.
  await readings(record, s, [[8 * MIN, 'warning']]);
  result = await readings(createWorkspaceHistory({ file }), s, [[9 * MIN, 'warning'], [10 * MIN, 'critical']]);
  assert.deepEqual(memoryEvents(result).slice(2), [[OPENED, 'warning', START + 8 * MIN], [OPENED, 'critical', START + 10 * MIN]]);
});

test('a history file from the previous build, without a recorded memory condition, keeps recording', async (t) => {
  const file = await tempFile(t), now = START;
  const previous = { uptimeSec: 900, internet: 'online', network: 'Wi-Fi', disconnections: 1, memory: 'warning', oomKills: 0,
    services: { 't3code.service': { state: 'running', startedAt: 100, restarts: 0 } }, health: {}, disks: {}, backup: 'unknown', backupFinished: null,
    workflow: { pumpState: 'idle', paused: false, timerActive: true, processes: { '7:1': { pid: 7, name: 'bun', state: 'Z' } }, jobs: {} } };
  const events = [ev(now - 2 * MIN, 'memory', OPENED, 'warning'), ev(now - 2 * MIN, 'agent-process:7:1', 'Workflow process stopped or zombie: bun (#7)', 'warning')];
  await writeFile(file, JSON.stringify({ version: 1, events, samples: [], previous, lastSuccessAt: null, startedAt: now - DAY }));
  const s = snapshot(now);
  s.diagnostics.agentWorkflow.processes = [{ id: '7:1', pid: 7, name: 'bun', state: 'Z' }];
  const record = createWorkspaceHistory({ file });
  // The old live level stands in for the recorded condition: the open incident settles, and the zombie it already recorded is not repeated.
  let result = await record(s);
  assert.equal(result.events.filter((e) => e.id.includes(':agent-process:')).length, 1);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', now - 2 * MIN]]);
  s.generatedAt = now + MEMORY_SETTLE_MS;
  result = await record(s);
  assert.deepEqual(memoryEvents(result), [[OPENED, 'warning', now - 2 * MIN], [RECOVERED, 'info', now]]);
  assert.deepEqual(byKey(result.episodes, 'memory').map((e) => [e.state, e.startedAt, e.endedAt]), [['recovered', now - 2 * MIN, now]]);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual([stored.previous.memoryRecorded, stored.previous.memoryHealthySince], ['healthy', null]);
});

test('two hours of memory flapping and transient zombies, as seen live on 2026-11-17, leave an HTTP-check incident in the history', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START), w = s.diagnostics.agentWorkflow, check = s.diagnostics.healthChecks[0];
  // Deterministic pseudo-random gaps of 30–90 seconds between level flips.
  let seed = 17;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  await record(s);
  let t = 30 * SEC, level = 'warning', flipAt = t, readingsDone = 0, result;
  while (t < 2 * 60 * MIN) {
    if (t >= flipAt) { level = level === 'warning' ? 'healthy' : 'warning'; flipAt = t + 30 * SEC + Math.floor(random() * 3) * 30 * SEC; }
    s.generatedAt = START + t;
    setMemory(s, level);
    // A headless browser child seen as a zombie for exactly one reading, eight times.
    const pid = 1000 + readingsDone;
    w.processes = readingsDone % 30 === 5 ? [{ id: `${pid}:1`, pid, name: 'chrome-headless', state: 'Z' }] : [];
    if (readingsDone % 30 === 4) w.processes = [{ id: `${pid + 1}:1`, pid: pid + 1, name: 'chrome-headless', state: 'S' }];
    check.state = t >= 40 * MIN && t < 45 * MIN ? 'unhealthy' : 'healthy';
    result = await record(s);
    t += 30 * SEC;
    readingsDone++;
  }
  for (const end = t + MEMORY_SETTLE_MS; t <= end; t += 30 * SEC) {
    s.generatedAt = START + t;
    result = await record(setMemory(s, 'healthy'));
  }
  const memory = byKey(result.episodes, 'memory');
  assert.ok(memory.length <= 3, `${memory.length} memory episodes`);
  assert.deepEqual(memory.map((e) => e.state), ['recovered']);
  assert.deepEqual(byKey(result.episodes, 't3-local').map((e) => [e.state, e.startedAt, e.endedAt]), [['recovered', START + 40 * MIN, START + 45 * MIN]]);
  assert.ok(!result.events.some((e) => e.id.includes(':agent-process:')));
  assert.ok(result.events.length < 10, `${result.events.length} events`);
  assert.ok(result.events.some((e) => e.title === 'Computer monitoring started'));
});
