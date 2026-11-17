import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceHistory, incidentEpisodes, isRoutineEvent, pruneEvents, MAX_EVENTS, MAX_ROUTINE_EVENTS } from '../workspace-history.mjs';

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

test('workflow processes appearing or disappearing record nothing, but a stopped or zombie process still warns', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START), w = s.diagnostics.agentWorkflow;
  await record(s);
  s.generatedAt += 30_000;
  w.processes = [{ id: '10:1', pid: 10, name: 'gh', state: 'S' }, { id: '11:1', pid: 11, name: 'bun', state: 'S' }];
  assert.ok(!(await record(s)).events.some((e) => e.id.includes(':agent-process:')));
  s.generatedAt += 30_000;
  w.processes = [{ id: '11:1', pid: 11, name: 'bun', state: 'Z' }, { id: '12:1', pid: 12, name: 'git', state: 'S' }];
  const result = await record(s);
  assert.deepEqual(result.events.filter((e) => e.id.includes(':agent-process:')).map((e) => [e.title, e.level]), [['Workflow process stopped or zombie: bun (#11)', 'warning']]);
  s.generatedAt += 30_000;
  w.processes = [];
  assert.equal((await record(s)).events.filter((e) => e.id.includes(':agent-process:')).length, 1);
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
