import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceHistory, isRoutineEvent, pruneEvents, MAX_EVENTS, MAX_ROUTINE_EVENTS } from '../workspace-history.mjs';

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
