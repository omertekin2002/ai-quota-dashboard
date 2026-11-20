import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceHistory, historyForApi, historySpan, incidentEpisodes, isRoutineEvent, pruneEvents, readHistoryFile, stateFileOf, MAX_EVENTS, API_EVENTS, API_EPISODES, FULL_WRITE_MS, MAX_ROUTINE_EVENTS, MAX_EPISODE_EVENTS, MEMORY_SETTLE_MS, LINK_SETTLE_MS, MONITOR_GAP_MS } from '../workspace-history.mjs';

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

test('pruning caps the total at MAX_EVENTS and lets routine activity fill only what is left', () => {
  const now = START;
  const event = (i, key, level = 'info') => ({ id: `${now - i * 1000}:${key}:Event ${i}`, timestamp: now - i * 1000, level, title: `Event ${i}` });
  const routine = Array.from({ length: 50 }, (_, i) => event(i, `agent-job:job-${i}`));
  const other = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => event(100 + i, 'internet', 'warning'));
  const full = pruneEvents([...routine, ...other], now);
  assert.equal(full.length, MAX_EVENTS);
  assert.equal(full.filter(isRoutineEvent).length, 0);
  const some = pruneEvents([...routine, ...other.slice(0, MAX_EVENTS - 10)], now);
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

test('restarts, OOM kills, zombie processes and pump failures are one-offs, never active', async () => {
  const record = createWorkspaceHistory(), s = richSnapshot(START), w = s.diagnostics.agentWorkflow;
  await record(s);
  s.generatedAt += MIN;
  s.services[0].startedAt = 200; s.diagnostics.oomKills = 1; w.pumpState = 'failed';
  w.processes = [{ id: '9:1', pid: 9, name: 'bun', state: 'S' }];
  await record(s);
  s.generatedAt += MIN;
  w.processes = [{ id: '9:1', pid: 9, name: 'bun', state: 'Z' }];
  await record(s);
  s.generatedAt += MIN;
  const { episodes } = await record(s);
  assert.deepEqual(episodes.map((e) => e.title).sort(), ['Agent pipeline pump failed', 'Linux killed a process because memory ran out', 'T3 Code restarted', 'Workflow process stopped or zombie: bun (#9)']);
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

// ---------- Episode evidence ----------
const nonGap = (episode) => episode.events.filter((e) => !e.gap).length + (episode.omittedEvents ?? 0);

test('each episode lists the events that opened, extended and ended it, oldest first, and nothing else', () => {
  const now = START + 60 * MIN;
  const events = [
    ev(START + 40 * MIN, 'memory', 'Memory pressure recovered'),
    ev(START + 30 * MIN, 'internet', 'Internet connection restored'),
    ev(START + 20 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'critical'),
    ev(START + 10 * MIN, 'internet', 'Internet became offline', 'warning'),
    ev(START + 5 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'warning'),
    ev(START + 4 * MIN, 'agent-job:job-1', 'Workflow job job-1: failed', 'warning'),
    ev(START + 3 * MIN, 'oom', 'Linux killed a process because memory ran out', 'critical'),
    ev(START + 2 * MIN, 't3code.service', 'T3 Code: running'),
    ev(START + 50 * MIN, 'cli-health', 'Backend health: response failed', 'warning'),
  ];
  const episodes = incidentEpisodes(events, now);
  const [memory] = byKey(episodes, 'memory'), [internet] = byKey(episodes, 'internet'), [oom] = byKey(episodes, 'oom');
  const [service] = byKey(episodes, 't3code.service'), [check] = byKey(episodes, 'cli-health');
  assert.deepEqual(memory.events, [
    { timestamp: START + 5 * MIN, level: 'warning', title: 'Memory pressure elevated or available RAM low' },
    { timestamp: START + 20 * MIN, level: 'critical', title: 'Memory pressure elevated or available RAM low' },
    { timestamp: START + 40 * MIN, level: 'info', title: 'Memory pressure recovered' },
  ]);
  assert.deepEqual(internet.events.map((e) => e.title), ['Internet became offline', 'Internet connection restored']);
  // A one-off's row is its only event, so it carries no list.
  assert.equal(oom.events, undefined);
  assert.equal(oom.eventCount, 1);
  assert.deepEqual(service.events.map((e) => e.title), ['T3 Code: running']);
  assert.deepEqual(check.events.map((e) => [e.title, e.level]), [['Backend health: response failed', 'warning']]);
  for (const episode of episodes.filter((e) => e.state !== 'once')) {
    assert.equal(episode.eventCount, nonGap(episode), episode.key);
    assert.equal(episode.omittedEvents, undefined, episode.key);
    // No ids or other recorder fields leak into the API.
    for (const e of episode.events) assert.deepEqual(Object.keys(e).sort(), ['level', 'timestamp', 'title']);
  }
});

test('an episode with a restart or monitoring caveat lists the gap events inside it, and only those', () => {
  const now = START + 60 * MIN;
  const episodes = incidentEpisodes([
    ev(START + 55 * MIN, 'boot', 'Computer restarted'),
    ev(START + 50 * MIN, 'internet', 'Internet connection restored'),
    ev(START + 50 * MIN, 'boot', 'Computer restarted'),
    ev(START + 40 * MIN, 'internet', 'Internet became offline', 'warning'),
    ev(START + 30 * MIN, 'monitor', 'Computer monitoring started'),
    ev(START + 20 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'warning'),
    ev(START + 10 * MIN, 'boot', 'Computer restarted'),
  ], now);
  const [memory] = byKey(episodes, 'memory'), [internet] = byKey(episodes, 'internet');
  // The active memory episode runs to now: the monitoring gap and both later restarts are inside, the first restart is not.
  assert.deepEqual(memory.events.map((e) => [e.timestamp, e.title, e.gap ?? false, e.key]), [
    [START + 20 * MIN, 'Memory pressure elevated or available RAM low', false, undefined],
    [START + 30 * MIN, 'Computer monitoring started', true, 'monitor'],
    [START + 50 * MIN, 'Computer restarted', true, 'boot'],
    [START + 55 * MIN, 'Computer restarted', true, 'boot'],
  ]);
  assert.equal(memory.caveats.length, 2);
  // A restart in the same reading as the recovery is inside the episode; the one after it ended is not.
  assert.deepEqual(internet.events.map((e) => [e.timestamp, e.title, e.gap ?? false]), [
    [START + 40 * MIN, 'Internet became offline', false],
    [START + 50 * MIN, 'Internet connection restored', false],
    [START + 50 * MIN, 'Computer restarted', true],
  ]);
  for (const episode of episodes) assert.equal(episode.eventCount, nonGap(episode));
  // No caveat, no gap entries.
  const plain = incidentEpisodes([ev(START + 2 * MIN, 'boot', 'Computer restarted'), ev(START + 3 * MIN, 'internet', 'Internet became offline', 'warning')], now);
  assert.deepEqual(plain[0].caveats, []);
  assert.ok(plain[0].events.every((e) => !e.gap));
});

test('an episode lists at most MAX_EPISODE_EVENTS entries, keeping the first, the newest and its gaps, and counts the rest', () => {
  const now = START + 200 * MIN;
  // 40 warnings for one HTTP check (alternating failed/unavailable), a restart in the middle, then the recovery.
  const events = Array.from({ length: 40 }, (_, i) => ev(START + i * MIN, 'cli-health', i % 2 ? 'Backend health: check unavailable' : 'Backend health: response failed', 'warning'));
  events.push(ev(START + 10 * MIN + 1, 'boot', 'Computer restarted'), ev(START + 100 * MIN, 'cli-health', 'Backend health: response recovered'));
  const [episode] = incidentEpisodes(events, now);
  assert.equal(MAX_EPISODE_EVENTS, 20);
  assert.equal(episode.eventCount, 41);
  assert.equal(episode.events.length, MAX_EPISODE_EVENTS);
  assert.deepEqual(episode.events[0], { timestamp: START, level: 'warning', title: 'Backend health: response failed' });
  assert.equal(episode.events.at(-1).title, 'Backend health: response recovered');
  assert.ok(episode.events.some((e) => e.gap && e.key === 'boot'), 'the restart behind the caveat is kept');
  // Then the newest warnings: the first, the gap, 17 newest warnings and the recovery.
  assert.deepEqual(episode.events.filter((e) => !e.gap).slice(1, -1).map((e) => e.timestamp), Array.from({ length: 17 }, (_, i) => START + (23 + i) * MIN));
  assert.equal(episode.omittedEvents, 41 - 19);
  assert.equal(episode.eventCount, nonGap(episode));
  // Still oldest first.
  assert.deepEqual(episode.events.map((e) => e.timestamp), episode.events.map((e) => e.timestamp).sort((a, b) => a - b));
  // At the cap exactly, nothing is dropped.
  const [full] = incidentEpisodes(events.slice(0, MAX_EPISODE_EVENTS), now);
  assert.equal(full.events.length, MAX_EPISODE_EVENTS);
  assert.equal(full.omittedEvents, undefined);
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
  // Only `droppedAt` is new; an older build ignores it. This file was under the old cap, so nothing was dropped.
  assert.deepEqual(Object.keys(stored).sort(), ['droppedAt', 'events', 'lastSuccessAt', 'previous', 'samples', 'startedAt', 'version']);
  assert.equal(stored.droppedAt, null);
  assert.deepEqual(stored.events, events);
  assert.deepEqual([result.oldestAt, result.trimmed], [now - 4 * DAY, false]);
});

const monitorEvents = (result) => result.events.filter((e) => /^\d+:(monitor|boot):/.test(e.id)).map((e) => [e.title, e.timestamp]).reverse();

test('a dashboard restart after a gap in readings records a monitor marker, so an incident spanning it gets its caveat', async (t) => {
  const file = await tempFile(t), s = snapshot(START);
  const first = createWorkspaceHistory({ file });
  await first(s);
  s.generatedAt = START + MIN;
  s.internet.state = 'offline';
  await first(s);
  // The dashboard is stopped for an hour while the internet is down, then resumes from its saved history.
  s.generatedAt = START + 61 * MIN;
  s.internet.state = 'online';
  let result = await createWorkspaceHistory({ file })(s);
  const RESUMED = 'Computer monitoring resumed after 60 minutes without readings';
  assert.deepEqual(monitorEvents(result), [['Computer monitoring started', START], [RESUMED, START + 61 * MIN]]);
  const [internet] = byKey(result.episodes, 'internet');
  assert.deepEqual([internet.state, internet.startedAt, internet.endedAt], ['recovered', START + MIN, START + 61 * MIN]);
  assert.deepEqual(internet.caveats.map((c) => c.split(';')[0]), ['Monitoring restarted during this incident']);
  assert.deepEqual(internet.events.map((e) => [e.title, e.gap ?? false]), [['Internet became offline', false], ['Internet connection restored', false], [RESUMED, true]]);
  // A quick restart, such as an auto-update, records nothing.
  s.generatedAt = START + 61 * MIN + MONITOR_GAP_MS - 1;
  result = await createWorkspaceHistory({ file })(s);
  assert.equal(monitorEvents(result).length, 2);
  // A computer restart is recorded once, by its own marker.
  s.generatedAt = START + 90 * MIN;
  s.uptimeSec = 60;
  const afterBoot = createWorkspaceHistory({ file });
  result = await afterBoot(s);
  assert.deepEqual(monitorEvents(result).slice(2), [['Computer restarted', START + 90 * MIN]]);
  // Only a restart counts: a slow reading in a running dashboard is not a monitoring restart.
  s.generatedAt = START + 100 * MIN;
  s.uptimeSec = 660;
  result = await afterBoot(s);
  assert.equal(monitorEvents(result).length, 3);
  // Longer gaps are given in hours.
  s.generatedAt = START + 280 * MIN;
  s.uptimeSec = 11_460;
  result = await createWorkspaceHistory({ file })(s);
  assert.deepEqual(monitorEvents(result).at(-1), ['Computer monitoring resumed after 3 hours without readings', START + 280 * MIN]);
});

test('a history file from the previous build, without a reading time, measures the gap from its newest sample', async (t) => {
  const file = await tempFile(t), now = START;
  const previous = { uptimeSec: 900, internet: 'online', network: 'Wi-Fi', disconnections: 1, memory: 'healthy', oomKills: 0,
    services: { 't3code.service': { state: 'running', startedAt: 100, restarts: 0 } }, health: {}, disks: {}, backup: 'unknown', backupFinished: null };
  const samples = [{ timestamp: now - 11 * MIN, state: 'online', latencyMs: 40 }, { timestamp: now - 10 * MIN, state: 'online', latencyMs: 50 }];
  await writeFile(file, JSON.stringify({ version: 1, events: [], samples, previous, lastSuccessAt: null, startedAt: now - DAY }));
  const result = await createWorkspaceHistory({ file })(snapshot(now));
  assert.deepEqual(monitorEvents(result), [['Computer monitoring resumed after 10 minutes without readings', now]]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).previous.readAt, now);
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
  const stored = await readHistoryFile(file);
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
  const stored = await readHistoryFile(file);
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

// ---------- Link drop bursts ----------
const linkEvents = (result) => result.events.filter((e) => e.id.includes(':link:')).map((e) => [e.title, e.level, e.timestamp]).reverse();
const UNSTABLE = (n) => `Network link unstable: dropped ${n} time(s)`, STEADY = (n) => `Network link steady again after ${n} drop${n === 1 ? '' : 's'}`;

// Records one reading per [offset, counter], offsets relative to START; a null counter is an unreadable reading.
async function linkReadings(record, s, steps) {
  let result;
  for (const [offset, counter] of steps) {
    s.generatedAt = START + offset;
    s.internet.disconnections = counter;
    result = await record(s);
  }
  return result;
}

// Readings every 30 seconds from `from` to `to` inclusive, all with the same counter.
const quiet = (from, to, counter) => {
  const steps = [];
  for (let t = from; t <= to; t += 30 * SEC) steps.push([t, counter]);
  return steps;
};

test('a burst of link drops over several readings records one warning and stays one active episode', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  // +1, +2, +1, each 30 seconds to 2 minutes apart, with quiet readings between.
  const result = await linkReadings(record, s, [[0, 10], [30 * SEC, 11], [MIN, 11], [2 * MIN, 13], [3 * MIN, 13], [4 * MIN, 14], [4 * MIN + 30 * SEC, 14]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + 30 * SEC]]);
  assert.deepEqual(byKey(result.episodes, 'link').map((e) => [e.state, e.startedAt, e.endedAt, e.eventCount, e.title]), [['active', START + 30 * SEC, null, 1, UNSTABLE(1)]]);
});

test('a link incident recovers after the settle time without drops, dated to the first reading after the last drop, with the total count', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  const lastDrop = 4 * MIN;
  let result = await linkReadings(record, s, [[0, 10], [30 * SEC, 11], [2 * MIN, 13], [lastDrop, 14], ...quiet(lastDrop + 30 * SEC, lastDrop + LINK_SETTLE_MS - 30 * SEC, 14)]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + 30 * SEC]]);
  // The reading that completes the settle time records the recovery exactly once.
  result = await linkReadings(record, s, [[lastDrop + LINK_SETTLE_MS, 14], [lastDrop + LINK_SETTLE_MS + 30 * SEC, 14], [lastDrop + LINK_SETTLE_MS + 5 * MIN, 14]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + 30 * SEC], [STEADY(4), 'info', START + lastDrop + 30 * SEC]]);
  const [episode] = byKey(result.episodes, 'link');
  assert.deepEqual([episode.state, episode.startedAt, episode.endedAt, episode.eventCount, episode.level], ['recovered', START + 30 * SEC, START + lastDrop + 30 * SEC, 2, 'warning']);
  // A later drop opens a new incident.
  result = await linkReadings(record, s, [[lastDrop + LINK_SETTLE_MS + 10 * MIN, 15]]);
  assert.deepEqual(byKey(result.episodes, 'link').map((e) => e.state), ['active', 'recovered']);
});

test('a drop during the settle time continues the same link incident and restarts the settle time', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  const second = MIN + LINK_SETTLE_MS - 30 * SEC;
  let result = await linkReadings(record, s, [[0, 5], [MIN, 6], ...quiet(MIN + 30 * SEC, second - 30 * SEC, 6), [second, 8], ...quiet(second + 30 * SEC, second + LINK_SETTLE_MS - 30 * SEC, 8)]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN]]);
  result = await linkReadings(record, s, [[second + LINK_SETTLE_MS, 8]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN], [STEADY(3), 'info', START + second + 30 * SEC]]);
  assert.deepEqual(byKey(result.episodes, 'link').map((e) => [e.state, e.startedAt, e.endedAt]), [['recovered', START + MIN, START + second + 30 * SEC]]);
});

test('unreadable link counters neither end nor reopen the incident, and a falling counter records no drop', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  // Unreadable through the whole settle time: the incident stays open.
  let result = await linkReadings(record, s, [[0, 10], [MIN, 11], [MIN + 30 * SEC, null], [10 * MIN, null], [20 * MIN, null], [30 * MIN, null]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN]]);
  assert.deepEqual(byKey(result.episodes, 'link').map((e) => e.state), ['active']);
  // Back with drops that happened during the gap: they join the open incident.
  result = await linkReadings(record, s, [[31 * MIN, 13]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN]]);
  // The settle time starts at the first readable reading after the last drop; unreadable ones inside it change nothing.
  result = await linkReadings(record, s, [[32 * MIN, 13], [33 * MIN, null], [40 * MIN, null], [31 * MIN + LINK_SETTLE_MS, null], [31 * MIN + LINK_SETTLE_MS + 30 * SEC, 13]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN], [STEADY(3), 'info', START + 32 * MIN]]);
  // Drops that show up after a long unreadable stretch, even one that began with a quiet reading, continue the incident.
  result = await linkReadings(record, s, [[50 * MIN, 14], [50 * MIN + 30 * SEC, 14], [51 * MIN, null], [70 * MIN, null], [71 * MIN, 24]]);
  assert.deepEqual(linkEvents(result).slice(2), [[UNSTABLE(1), 'warning', START + 50 * MIN]]);
  result = await linkReadings(record, s, [[71 * MIN + 30 * SEC, 24], [71 * MIN + LINK_SETTLE_MS, 24]]);
  assert.deepEqual(linkEvents(result).slice(2), [[UNSTABLE(1), 'warning', START + 50 * MIN], [STEADY(11), 'info', START + 71 * MIN + 30 * SEC]]);
  // A reset counter (reboot, interface reset) re-baselines without a drop; the next rise counts from the new value.
  result = await linkReadings(record, s, [[100 * MIN, 2], [101 * MIN, null], [102 * MIN, 0], [103 * MIN, 0]]);
  assert.equal(linkEvents(result).length, 4);
  result = await linkReadings(record, s, [[104 * MIN, 1]]);
  assert.deepEqual(linkEvents(result).at(-1), [UNSTABLE(1), 'warning', START + 104 * MIN]);
  // A reset during an open incident cannot confirm the quiet time before it: the settle time starts again from the reset.
  result = await linkReadings(record, s, [[105 * MIN, 1], [104 * MIN + LINK_SETTLE_MS, 0]]);
  assert.equal(linkEvents(result).length, 5);
  result = await linkReadings(record, s, [[104 * MIN + LINK_SETTLE_MS + 30 * SEC, 0], [104 * MIN + 2 * LINK_SETTLE_MS - 30 * SEC, 0]]);
  assert.equal(linkEvents(result).length, 5);
  result = await linkReadings(record, s, [[104 * MIN + 2 * LINK_SETTLE_MS, 0]]);
  assert.deepEqual(linkEvents(result).at(-1), [STEADY(1), 'info', START + 104 * MIN + LINK_SETTLE_MS + 30 * SEC]);
});

test('a network change records no link drops and does not reopen a link incident', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  await linkReadings(record, s, [[0, 10]]);
  s.internet.networkName = 'Other';
  const result = await linkReadings(record, s, [[MIN, 0], [2 * MIN, 0]]);
  assert.deepEqual(linkEvents(result), []);
  assert.ok(result.events.some((e) => e.title === 'Network connected or changed'));
});

test('a network change during an open link incident restarts its settle time instead of confirming it', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  await linkReadings(record, s, [[0, 10], [MIN, 11], [2 * MIN, 11]]);
  s.internet.networkName = 'Other';
  let result = await linkReadings(record, s, [[MIN + LINK_SETTLE_MS, 3]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN]]);
  result = await linkReadings(record, s, [[MIN + LINK_SETTLE_MS + 30 * SEC, 3], [MIN + 2 * LINK_SETTLE_MS, 3]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(1), 'warning', START + MIN], [STEADY(1), 'info', START + MIN + LINK_SETTLE_MS + 30 * SEC]]);
});

test('an unreadable counter on a new network does not carry the old network\'s counter as its baseline', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  await linkReadings(record, s, [[0, 5]]);
  s.internet.networkName = 'Other';
  const result = await linkReadings(record, s, [[MIN, null], [2 * MIN, 100], [3 * MIN, 100]]);
  assert.deepEqual(linkEvents(result), []);
});

test('the open link incident, its drop count and settle time survive a restart of the recorder', async (t) => {
  const file = await tempFile(t), s = snapshot(START);
  await linkReadings(createWorkspaceHistory({ file }), s, [[0, 10], [MIN, 12], [2 * MIN, 13], [3 * MIN, 13]]);
  const stored = await readHistoryFile(file);
  assert.deepEqual(stored.previous.link, { drops: 3, lastDropAt: START + 2 * MIN, steadySince: START + 3 * MIN });
  // A new recorder continues the incident: another drop joins it instead of opening a second one.
  let result = await linkReadings(createWorkspaceHistory({ file }), s, [[4 * MIN, 14], [5 * MIN, 14]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(2), 'warning', START + MIN]]);
  // And another one finishes it with the total from before both restarts.
  result = await linkReadings(createWorkspaceHistory({ file }), s, [[4 * MIN + LINK_SETTLE_MS, 14]]);
  assert.deepEqual(linkEvents(result), [[UNSTABLE(2), 'warning', START + MIN], [STEADY(4), 'info', START + 5 * MIN]]);
  assert.equal((await readHistoryFile(file)).previous.link, null);
});

test('a history file from the previous build, without link incident state, starts with no open incident', async (t) => {
  const file = await tempFile(t), now = START;
  const legacy = ev(now - 2 * MIN, 'link', 'Network link dropped 2 time(s) between readings', 'warning');
  const previous = { uptimeSec: 900, internet: 'online', network: 'Wi-Fi', disconnections: 5, memory: 'healthy', oomKills: 0,
    services: { 't3code.service': { state: 'running', startedAt: 100, restarts: 0 } }, health: {}, disks: {}, backup: 'unknown', backupFinished: null };
  await writeFile(file, JSON.stringify({ version: 1, events: [legacy], samples: [], previous, lastSuccessAt: null, startedAt: now - DAY }));
  const s = snapshot(now);
  const record = createWorkspaceHistory({ file });
  let result = await linkReadings(record, s, [[0, 5], [LINK_SETTLE_MS, 5]]);
  assert.deepEqual(linkEvents(result), [['Network link dropped 2 time(s) between readings', 'warning', now - 2 * MIN]]);
  result = await linkReadings(record, s, [[LINK_SETTLE_MS + MIN, 6]]);
  assert.deepEqual(linkEvents(result).at(-1), [UNSTABLE(1), 'warning', now + LINK_SETTLE_MS + MIN]);
  // The legacy per-reading event stays a one-off next to the new active incident.
  assert.deepEqual(byKey(result.episodes, 'link').map((e) => [e.title, e.state]), [[UNSTABLE(1), 'active'], ['Network link dropped 2 time(s) between readings', 'once']]);
});

test('legacy per-reading link drop events stay one-offs', () => {
  const episodes = incidentEpisodes([
    ev(START + 2 * MIN, 'link', 'Network link dropped 3 time(s) between readings', 'warning'),
    ev(START + MIN, 'link', 'Network link dropped 1 time(s) between readings', 'warning'),
  ], START + 3 * MIN);
  assert.deepEqual(episodes.map((e) => [e.title, e.state, e.eventCount, e.startedAt, e.endedAt]), [
    ['Network link dropped 3 time(s) between readings', 'once', 1, START + 2 * MIN, START + 2 * MIN],
    ['Network link dropped 1 time(s) between readings', 'once', 1, START + MIN, START + MIN],
  ]);
});

test('a day of Wi-Fi drop bursts, as seen live on 2026-11-17/18, records about two events per burst instead of one per reading', async () => {
  const record = createWorkspaceHistory(), s = snapshot(START);
  // Deterministic pseudo-random bursts: 2–12 drop readings 30–120 seconds apart, then 1–4 quiet hours.
  let seed = 18;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let counter = 100, t = 0, dropReadings = 0, result;
  const steps = [[t, counter]];
  const BURSTS = 11;
  for (let burst = 0; burst < BURSTS; burst++) {
    t += 60 * MIN + Math.floor(random() * 7) * 30 * MIN;
    const drops = 2 + Math.floor(random() * 11);
    for (let i = 0; i < drops; i++) {
      counter += 1 + Math.floor(random() * 3);
      steps.push([t, counter]);
      dropReadings++;
      // Quiet readings every 30 seconds until the next drop, 30–120 seconds later.
      const gap = 30 * SEC * (1 + Math.floor(random() * 4));
      for (let q = t + 30 * SEC; q < t + gap; q += 30 * SEC) steps.push([q, counter]);
      t += gap;
    }
    // Quiet readings every 30 seconds until the next burst.
    for (let q = t; q < t + 60 * MIN; q += 30 * SEC) steps.push([q, counter]);
  }
  steps.push(...quiet(t + 60 * MIN, t + 60 * MIN + LINK_SETTLE_MS, counter));
  result = await linkReadings(record, s, steps);
  const link = linkEvents(result);
  assert.ok(dropReadings > 50, `${dropReadings} drop readings`);
  // One event per drop reading before; one warning and one recovery per burst now.
  assert.equal(link.length, 2 * BURSTS);
  assert.equal(link.filter(([, level]) => level === 'warning').length, BURSTS);
  const episodes = byKey(result.episodes, 'link');
  assert.equal(episodes.length, BURSTS);
  assert.ok(episodes.every((e) => e.state === 'recovered' && e.eventCount === 2));
  assert.equal(link.filter(([, level]) => level === 'info').reduce((sum, [title]) => sum + Number(/after (\d+) drop/.exec(title)[1]), 0), counter - 100);
});

// ---------- Seven-day budget, API trimming and history span ----------
// A week as recorded live in November 2026: incident events in failure/recovery pairs, `perDay` a day, the
// oldest a minute inside the seven days and the newest a moment before `now`. Newest first.
const WEEK_KINDS = [
  ['memory', 'Memory pressure elevated or available RAM low', 'warning', 'Memory pressure recovered'],
  ['link', 'Network link unstable: dropped 2 time(s)', 'warning', 'Network link steady again after 2 drops'],
  ['internet', 'Internet became limited', 'warning', 'Internet connection restored'],
  ['t3-tailscale', 'T3 Code · Tailscale web: response failed', 'warning', 'T3 Code · Tailscale web: response recovered'],
  ['backup', 'T7 backup failed', 'critical', 'T7 backup completed successfully'],
  ['agent-timer', 'Agent pump timer inactive', 'warning', 'Agent pump timer enabled'],
];
function liveWeek(now, perDay = 90) {
  const step = (7 * DAY - 2 * MIN) / (7 * perDay), first = now - 7 * DAY + MIN, events = [];
  for (let i = 0; i < 7 * perDay; i++) {
    const [key, opened, level, closed] = WEEK_KINDS[Math.floor(i / 2) % WEEK_KINDS.length], t = Math.round(first + i * step);
    events.push(i % 2 ? ev(t, key, closed) : ev(t, key, opened, level));
  }
  return events.reverse();
}
const quietPrevious = (now) => ({ readAt: now - 30_000, uptimeSec: 900, internet: 'online', network: 'Wi-Fi', disconnections: 1, memory: 'healthy', oomKills: 0,
  services: { 't3code.service': { state: 'running', startedAt: 100, restarts: 0 } }, health: {}, disks: {}, backup: 'unknown', backupFinished: null });

test('seven days at about 90 incident events a day are all kept, and nothing older is', () => {
  const now = START + 30 * DAY, week = liveWeek(now);
  assert.equal(week.length, 630);
  const routine = Array.from({ length: 200 }, (_, i) => ev(now - i * 45 * MIN - 1000, `agent-job:job-${i}`, `Workflow job job-${i}: done`));
  const old = [ev(now - 7 * DAY - MIN, 'internet', 'Internet became limited', 'warning'), ev(now - 8 * DAY, 'memory', 'Memory pressure recovered')];
  const kept = pruneEvents([...old, ...routine, ...week], now);
  assert.deepEqual(kept.filter((e) => !isRoutineEvent(e)).map((e) => e.id), week.map((e) => e.id));
  // Routine activity still keeps only its newest 20 events.
  assert.deepEqual(kept.filter(isRoutineEvent).map((e) => e.title), routine.slice(0, MAX_ROUTINE_EVENTS).map((e) => e.title));
  assertWellFormed(kept, now);
  // Every failure in the week pairs with its recovery; none lost its start.
  const episodes = incidentEpisodes(kept, now);
  assert.equal(episodes.length, 315);
  assert.ok(episodes.every((e) => e.state === 'recovered' && e.startedAt != null && e.eventCount === 2));
});

test('/api/workspace serves the newest events and episodes, every active one and the true totals, paired from the full history', async (t) => {
  const file = await tempFile(t), now = START + 30 * DAY;
  // A service that failed three days ago and recovered a minute ago, among a week of other incidents.
  const events = [ev(now - MIN, 't3code.service', 'T3 Code: running'), ...liveWeek(now - 30_000), ev(now - 3 * DAY, 't3code.service', 'T3 Code: failed', 'warning')]
    .sort((a, b) => b.timestamp - a.timestamp);
  await writeFile(file, JSON.stringify({ version: 1, events, samples: [], previous: quietPrevious(now), lastSuccessAt: null, startedAt: now - 20 * DAY, droppedAt: null }));
  const record = createWorkspaceHistory({ file });
  const result = await record(snapshot(now)), api = historyForApi(result);
  assert.equal(result.events.length, 632);
  assert.deepEqual([api.events.length, api.eventCount, api.eventLimit], [API_EVENTS, 632, MAX_EVENTS]);
  assert.deepEqual(api.events, result.events.slice(0, API_EVENTS));
  assert.deepEqual([api.episodes.length, api.episodeCount], [API_EPISODES, result.episodes.length]);
  assert.ok(api.episodeCount > 300);
  assert.deepEqual(api.episodes, result.episodes.slice(0, API_EPISODES));
  const [service] = byKey(api.episodes, 't3code.service');
  assert.deepEqual([service.state, service.startedAt, service.endedAt, service.caveats], ['recovered', now - 3 * DAY, now - MIN, []]);
  assert.ok(api.episodes.every((e) => e.startedAt != null), 'no start is reported as not retained');
  // More active incidents than API_EPISODES: every one is served, ahead of the recovered ones.
  const failing = Array.from({ length: API_EPISODES + 5 }, (_, i) => ev(now - 3 * DAY + i * 1000, `check-${i}`, `Check ${i}: response failed`, 'warning'));
  const busy = historyForApi({ ...result, episodes: incidentEpisodes([...failing, ...result.events], now) });
  assert.equal(busy.episodes.length, API_EPISODES + 5);
  assert.ok(busy.episodes.every((e) => e.state === 'active'));
  assert.equal(busy.episodeCount, api.episodeCount + API_EPISODES + 5);
  // The live-sized response is smaller than serving everything was.
  assert.ok(JSON.stringify(api).length < JSON.stringify(result).length / 10);
});

test('the history span says when monitoring started, covers at most seven days, and starts later when the cap dropped events', () => {
  const now = START + 30 * DAY, events = liveWeek(now, 10);
  assert.deepEqual(historySpan({ events, startedAt: now - DAY, droppedAt: null }, now), { oldestAt: now - DAY, trimmed: false });
  assert.deepEqual(historySpan({ events, startedAt: now - 20 * DAY, droppedAt: null }, now), { oldestAt: now - 7 * DAY, trimmed: false });
  assert.deepEqual(historySpan({ events: [], startedAt: null, droppedAt: null }, now), { oldestAt: now, trimmed: false });
  // A cap drop within the seven days moves the start to the oldest kept incident event, not a routine one.
  const routine = ev(events.at(-1).timestamp - MIN, 'agent-job:job-1', 'Workflow job job-1: done');
  assert.deepEqual(historySpan({ events: [...events, routine], startedAt: now - 20 * DAY, droppedAt: events.at(-1).timestamp - 1 }, now), { oldestAt: events.at(-1).timestamp, trimmed: true });
  // A drop older than seven days no longer limits the span.
  assert.deepEqual(historySpan({ events, startedAt: now - 20 * DAY, droppedAt: now - 7 * DAY - 1 }, now), { oldestAt: now - 7 * DAY, trimmed: false });
});

test('the recorder notes when the cap drops an event, and a file from an older build full at its 100-event cap counts as trimmed', async (t) => {
  const now = START + 30 * DAY;
  // An older build's file at its cap: no `droppedAt`, 100 incident events over the last day and a half.
  const legacyFile = await tempFile(t), legacy = liveWeek(now, 100 / 7).slice(0, 100).map((e, i) => ({ ...e, timestamp: now - (i + 1) * 20 * MIN, id: e.id.replace(/^\d+/, now - (i + 1) * 20 * MIN) }));
  await writeFile(legacyFile, JSON.stringify({ version: 1, events: legacy, samples: [], previous: quietPrevious(now), lastSuccessAt: null, startedAt: now - 20 * DAY }));
  let result = await createWorkspaceHistory({ file: legacyFile })(snapshot(now));
  assert.deepEqual([result.events.length, result.trimmed, result.oldestAt], [100, true, now - 100 * 20 * MIN]);
  assert.equal(JSON.parse(await readFile(legacyFile, 'utf8')).droppedAt, now - 100 * 20 * MIN - 1);
  // One under the old cap is not.
  await writeFile(legacyFile, JSON.stringify({ version: 1, events: legacy.slice(0, 99), samples: [], previous: quietPrevious(now), lastSuccessAt: null, startedAt: now - 20 * DAY }));
  result = await createWorkspaceHistory({ file: legacyFile })(snapshot(now));
  assert.deepEqual([result.trimmed, result.oldestAt], [false, now - 7 * DAY]);
  // A history at MAX_EVENTS drops its oldest event when a new one comes in, and says so from then on.
  const file = await tempFile(t), full = liveWeek(now, MAX_EVENTS / 7);
  assert.equal(full.length, MAX_EVENTS);
  await writeFile(file, JSON.stringify({ version: 1, events: full, samples: [], previous: quietPrevious(now), lastSuccessAt: null, startedAt: now - 20 * DAY, droppedAt: null }));
  const record = createWorkspaceHistory({ file }), s = snapshot(now);
  result = await record(s);
  assert.deepEqual([result.trimmed, result.oldestAt], [false, now - 7 * DAY]);
  s.generatedAt += 30_000;
  s.internet.state = 'offline';
  result = await record(s);
  assert.equal(result.events.length, MAX_EVENTS);
  assert.deepEqual([result.trimmed, result.oldestAt], [true, full.at(-2).timestamp]);
  assert.equal((await readHistoryFile(file)).droppedAt, full.at(-1).timestamp);
  s.generatedAt += 30_000;
  result = await createWorkspaceHistory({ file })(s);
  assert.deepEqual([result.trimmed, result.oldestAt], [true, full.at(-2).timestamp]);
});

test('readings that record nothing rewrite only the small companion file, and a restart resumes from it', async (t) => {
  const file = await tempFile(t), s = snapshot(START), record = createWorkspaceHistory({ file });
  await record(s);
  const full = await readFile(file, 'utf8');
  for (let i = 1; i <= 4; i++) {
    s.generatedAt = START + i * 30_000;
    assert.equal((await record(s)).persisted, true);
  }
  assert.equal(await readFile(file, 'utf8'), full);
  const state = JSON.parse(await readFile(stateFileOf(file), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['previous', 'samples', 'version']);
  assert.equal(state.previous.readAt, START + 120_000);
  assert.equal((await readHistoryFile(file)).previous.readAt, START + 120_000);
  assert.equal((await readHistoryFile(file)).samples.length, state.samples.length);
  // A new event rewrites the full file.
  s.generatedAt += 30_000;
  s.internet.state = 'offline';
  await record(s);
  const changedAt = s.generatedAt;
  assert.equal(JSON.parse(await readFile(file, 'utf8')).previous.readAt, changedAt);
  // Without one, the full file is rewritten every FULL_WRITE_MS.
  s.generatedAt = changedAt + FULL_WRITE_MS - 1;
  await record(s);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).previous.readAt, changedAt);
  s.generatedAt = changedAt + FULL_WRITE_MS;
  await record(s);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).previous.readAt, changedAt + FULL_WRITE_MS);
  // Three minutes later only the companion file has the reading, and a restart a minute after it resumes from
  // there: no monitoring gap and no repeated event.
  s.generatedAt += 3 * MIN;
  await record(s);
  s.generatedAt += MIN;
  const result = await createWorkspaceHistory({ file })(s);
  assert.deepEqual(monitorEvents(result), [['Computer monitoring started', START]]);
  assert.equal(result.events.filter((e) => e.title === 'Internet became offline').length, 1);
  // A companion file older than the full file is ignored.
  await writeFile(stateFileOf(file), JSON.stringify({ version: 1, samples: [], previous: { ...quietPrevious(START), readAt: START } }));
  assert.equal((await readHistoryFile(file)).previous.internet, 'offline');
});

test('a failed full write is retried on later readings and never hidden by the companion file', async (t) => {
  const file = await tempFile(t), s = snapshot(START), record = createWorkspaceHistory({ file });
  await record(s);
  await mkdir(`${file}.tmp`); // the next full write fails
  s.generatedAt += 30_000;
  s.internet.state = 'offline';
  assert.equal((await record(s)).persisted, false);
  await assert.rejects(readFile(stateFileOf(file), 'utf8'));
  s.generatedAt += 30_000;
  assert.equal((await record(s)).persisted, false);
  await assert.rejects(readFile(stateFileOf(file), 'utf8'));
  await rm(`${file}.tmp`, { recursive: true });
  s.generatedAt += 30_000;
  assert.equal((await record(s)).persisted, true);
  assert.ok((await readHistoryFile(file)).events.some((e) => e.title === 'Internet became offline'));
});

test('a full seven-day history at the cap stays a bounded file, and each reading between full writes is small', async (t) => {
  const file = await tempFile(t), now = START + 30 * DAY, s = snapshot(now);
  const events = liveWeek(now, MAX_EVENTS / 7);
  const samples = Array.from({ length: 60 }, (_, i) => ({ timestamp: now - (60 - i) * 30_000, state: 'online', latencyMs: 123 }));
  await writeFile(file, JSON.stringify({ version: 1, events, samples, previous: quietPrevious(now), lastSuccessAt: null, startedAt: now - 20 * DAY, droppedAt: null }));
  const record = createWorkspaceHistory({ file });
  await record(s);
  s.generatedAt += 30_000;
  await record(s);
  const fullSize = (await readFile(file)).length, stateSize = (await readFile(stateFileOf(file))).length;
  t.diagnostic(`full file at ${MAX_EVENTS} events: ${fullSize} bytes; companion file: ${stateSize} bytes`);
  assert.ok(fullSize < 250_000, `${fullSize} bytes`);
  assert.ok(stateSize < 10_000, `${stateSize} bytes`);
});
