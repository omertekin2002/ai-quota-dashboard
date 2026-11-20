import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentWorkflowMonitor } from '../agent-workflow.mjs';
import { createWorkspaceHistory } from '../workspace-history.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-agent-processes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { procRoot: path.join(root, 'proc'), workflowHome: path.join(root, 'workflow'), repoRoot: path.join(root, 'repo'), t3Worktrees: path.join(root, 't3'), now: () => 10_000_000 };
  for (const dir of Object.values(options).filter((v) => typeof v === 'string')) await mkdir(dir, { recursive: true });
  async function file(name, value) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
  async function process(pid, ppid, cwd, argv, ticks = 1234) {
    const dir = path.join(options.procRoot, String(pid));
    await mkdir(dir, { recursive: true });
    await symlink(cwd, path.join(dir, 'cwd'));
    await writeFile(path.join(dir, 'cmdline'), argv.join('\0') + '\0');
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(ppid); fields[19] = String(ticks);
    await writeFile(path.join(dir, 'stat'), `${pid} (name with ) parentheses) ${fields.join(' ')}`);
  }
  return { root, options, file, process };
}

test('finds agentctl scripts, workflow directories, and descendants without matching prompt text', async (t) => {
  const f = await setup(t), outside = '/unrelated/project';
  await f.process(100, 1, outside, ['bun', `${f.options.repoRoot}/agentctl.ts`, 'heavy', 'PROMPT_SECRET_' + 'x'.repeat(5000)]);
  await f.process(101, 100, outside, ['node', 'build.js']);
  await f.process(102, 101, outside, ['flock', '/private/lock']);
  await f.process(200, 1, outside, ['zsh', '-lc', 'echo agentctl /some/agentctl.ts']);
  await f.process(201, 1, outside, ['node', 'server.js', '/some/agentctl.ts']);
  await f.process(202, 1, outside, ['codex', 'prompt mentions agentctl and build-workflow']);
  await f.process(300, 1, `${f.options.repoRoot}/src`, ['python', 'worker.py']);
  await f.process(400, 1, `${f.options.t3Worktrees}/thread-one`, ['claude']);
  await f.process(500, 1, outside, ['node', `${f.options.repoRoot}/agentctl.js`, 'review', '--api-key', 'CREDENTIAL_CANARY']);
  const rows = [[100, 1, 'bun'], [101, 100, 'node'], [102, 101, 'flock'], [200, 1, 'zsh'], [201, 1, 'node'], [202, 1, 'codex'], [300, 1, 'python'], [400, 1, 'claude'], [500, 1, 'node-MainThread']];
  const result = await createAgentWorkflowMonitor({ ...f.options, run: async (bin) => bin === 'ps' ? rows.map(([pid, ppid, name]) => `${pid} ${ppid} S 120 1.5 1000 ${name}`).join('\n') : null })();
  assert.deepEqual(result.processes.map((p) => p.pid), [100, 101, 102, 300, 400, 500]);
  assert.equal(result.count, 6);
  assert.equal(result.rssBytes, 6000 * 1024);
  assert.equal(result.cpuPct, 9);
  assert.equal(result.processes.find((p) => p.pid === 102).rootPid, 100);
  assert.equal(result.processes.find((p) => p.pid === 100).command, 'heavy');
  for (const secret of ['PROMPT_SECRET', 'CREDENTIAL_CANARY', outside, 'build.js']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('keeps a reparented child by process identity and rejects a reused PID', async (t) => {
  const f = await setup(t);
  await f.process(100, 1, '/elsewhere', ['bun', '/tools/agentctl.ts', 'heavy']);
  await f.process(101, 100, '/elsewhere', ['node', 'worker.js'], 2000);
  let rows = '100 1 S 120 1.0 1000 bun\n101 100 S 60 2.0 2000 node\n';
  const monitor = createAgentWorkflowMonitor({ ...f.options, run: async (bin) => bin === 'ps' ? rows : null });
  assert.equal((await monitor()).count, 2);
  rows = '101 1 S 90 2.0 2000 node\n';
  assert.equal((await monitor()).count, 1);
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '9999';
  await writeFile(path.join(f.options.procRoot, '101/stat'), `101 (node) ${fields.join(' ')}`);
  assert.equal((await monitor()).count, 0);
});

test('idle oneshot pump is normal, active jobs use configured heartbeat limits, and private fields stay private', async (t) => {
  const f = await setup(t), now = f.options.now();
  await f.file('workflow/status.json', { at: new Date(now - 1000).toISOString(), decision: 'quota exhausted, SECRET_DETAILS', quota: { token: 'PRIVATE_QUOTA' } });
  await f.file('repo/config.json', { staleMinutes: 2, launchTimeoutMinutes: 1, webhook: 'SECRET_WEBHOOK' });
  await f.file('workflow/jobs/job-running-001.json', { id: 'job-running-001', mode: 'implement', status: 'running', createdAt: new Date(now - 300_000).toISOString(), heartbeatAt: new Date(now - 180_000).toISOString(), title: 'PRIVATE_TITLE', notes: ['PRIVATE_NOTES'], summary: 'PRIVATE_SUMMARY' });
  await f.file('workflow/jobs/job-launched-001.json', { id: 'job-launched-001', mode: 'task', status: 'launched', createdAt: new Date(now - 70_000).toISOString() });
  await f.file('workflow/jobs/job-finished-001.json', { id: 'job-finished-001', mode: 'plan', status: 'done', finishedAt: new Date(now - 1000).toISOString() });
  const commands = [];
  const monitor = createAgentWorkflowMonitor({ ...f.options, run: async (bin) => {
    commands.push(bin);
    return bin === 'ps' ? '' : 'Id=agent-pump.service\nLoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n\nId=agent-pump.timer\nLoadState=loaded\nActiveState=active\n';
  } });
  const result = await monitor();
  assert.equal(result.pumpState, 'idle');
  assert.equal(result.timerActive, true);
  assert.equal(result.reason, 'Waiting for quota');
  assert.equal(result.activeCount, 2);
  assert.equal(result.staleCount, 2);
  assert.equal(result.recentJobs[0].status, 'done');
  assert.ok(commands.every((c) => ['ps', 'systemctl'].includes(c)));
  for (const secret of ['SECRET_', 'PRIVATE_', 'webhook', 'notes', 'summary']) assert.ok(!JSON.stringify(result).includes(secret));
  await f.file('workflow/PAUSED', 'paused');
  assert.equal((await monitor()).reason, 'Paused');
});

test('daily plans use the pump launch counter and configured limit, and roll over at midnight UTC', async (t) => {
  const f = await setup(t);
  let now = Date.parse('2026-10-26T23:59:59.999Z');
  await f.file('repo/config.json', { maxPlansPerDay: 42, webhook: 'PRIVATE_WEBHOOK' });
  await f.file('workflow/state.json', { plansByDay: { '2026-10-25': 99, '2026-10-26': 25 }, repos: { private: 'PRIVATE_REPO' } });
  // Job history is not the counter: failed launches still consume the pump's cap.
  await f.file('workflow/jobs/job-failed-plan.json', { id: 'job-failed-plan', mode: 'plan', status: 'failed' });
  const monitor = createAgentWorkflowMonitor({ ...f.options, now: () => now, run: async () => null });
  const result = await monitor();
  assert.deepEqual(result.dailyPlans, { day: '2026-10-26', launched: 25, limit: 42, remaining: 17, resetsAt: Date.parse('2026-10-27T00:00:00Z') });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  now += 1;
  assert.deepEqual((await monitor()).dailyPlans, { day: '2026-10-27', launched: 0, limit: 42, remaining: 42, resetsAt: Date.parse('2026-10-28T00:00:00Z') });
});

test('daily plans use the cap saved with Plans per day (settings.json) over config.json, like the pump', async (t) => {
  const f = await setup(t);
  await f.file('repo/config.json', { maxPlansPerDay: 12 });
  await f.file('workflow/state.json', { plansByDay: { '1970-01-01': 49 } });
  const monitor = createAgentWorkflowMonitor({ ...f.options, run: async () => null });
  assert.deepEqual((await monitor()).dailyPlans, { day: '1970-01-01', launched: 49, limit: 12, remaining: 0, resetsAt: 86_400_000 });
  const cases = [
    { settings: { maxPlansPerDay: 60 }, limit: 60, remaining: 11 },
    { settings: { maxPlansPerDay: 0 }, limit: 0, remaining: 0 },
    { settings: { maxPlansPerDay: '75' }, limit: 75, remaining: 26 },
    // Entries agentctl ignores leave config.json's value in effect.
    { settings: { maxPlansPerDay: 101 }, limit: 12, remaining: 0 },
    { settings: { maxPlansPerDay: -1 }, limit: 12, remaining: 0 },
    { settings: { maxPlansPerDay: 2.5 }, limit: 12, remaining: 0 },
    { settings: { maxPlansPerDay: null }, limit: 12, remaining: 0 },
    { settings: { maxWorkers: 3 }, limit: 12, remaining: 0 },
    { settings: [60], limit: 12, remaining: 0 },
    { settings: 'invalid JSON', limit: 12, remaining: 0 },
  ];
  for (const c of cases) {
    await f.file('workflow/settings.json', c.settings);
    const plans = (await monitor()).dailyPlans;
    assert.equal(plans.limit, c.limit, JSON.stringify(c.settings));
    assert.equal(plans.remaining, c.remaining, JSON.stringify(c.settings));
  }
  // The saved cap applies even when config.json can't be read.
  await f.file('workflow/settings.json', { maxPlansPerDay: 60 });
  await f.file('repo/config.json', 'invalid JSON');
  assert.equal((await monitor()).dailyPlans.limit, 60);
});

test('daily plans preserve unavailable readings and handle zero or exceeded limits', async (t) => {
  const f = await setup(t);
  const monitor = createAgentWorkflowMonitor({ ...f.options, run: async () => null });
  assert.deepEqual((await monitor()).dailyPlans, { day: '1970-01-01', launched: null, limit: null, remaining: null, resetsAt: 86_400_000 });
  const state = (count) => ({ plansByDay: { '1970-01-01': count } });
  const cases = [
    { state: 'invalid JSON', limit: 30, launched: null, remaining: null },
    { state: {}, limit: 30, launched: null, remaining: null },
    { state: { plansByDay: [] }, limit: 30, launched: null, remaining: null },
    { state: state(-1), limit: 30, launched: null, remaining: null },
    { state: state('25'), limit: 30, launched: null, remaining: null },
    { state: state(null), limit: 30, launched: null, remaining: null },
    { state: state(25), limit: '30', launched: 25, remaining: null },
    { state: state(25), limit: -1, launched: 25, remaining: null },
    { state: state(25), limit: 20, launched: 25, remaining: 0 },
    { state: state(0), limit: 0, launched: 0, remaining: 0 },
  ];
  for (const c of cases) {
    await f.file('workflow/state.json', c.state);
    await f.file('repo/config.json', { maxPlansPerDay: c.limit });
    const plans = (await monitor()).dailyPlans;
    assert.equal(plans.launched, c.launched);
    assert.equal(plans.limit, typeof c.limit === 'number' && c.limit >= 0 ? c.limit : null);
    assert.equal(plans.remaining, c.remaining);
  }
});

test('unreadable process/job sources are unknown and malformed job records are partial', async (t) => {
  const f = await setup(t);
  const monitor = createAgentWorkflowMonitor({ ...f.options, run: async () => null });
  const result = await monitor();
  assert.equal(result.available, false);
  assert.equal(result.count, null);
  assert.equal(result.jobsAvailable, false);
  assert.equal(result.activeCount, null);
  await f.file('workflow/jobs/broken-job-001.json', 'not JSON');
  const partial = await monitor();
  assert.equal(partial.jobsAvailable, true);
  assert.equal(partial.partial, true);
});

test('workflow lifecycle events survive missing sources and never record routine process starts or exits', async () => {
  const record = createWorkspaceHistory();
  const s = { generatedAt: 1000000, uptimeSec: 100, memory: null, internet: { state: 'online', latencyMs: 1 }, services: [],
    diagnostics: { pressure: { memory: null }, oomKills: 0, healthChecks: [], disks: [], backup: { state: 'unknown' },
      agentWorkflow: { available: true, processes: [], jobsAvailable: true, partial: false, activeJobs: [], recentJobs: [], pumpState: 'idle', paused: false, timerActive: true } } };
  await record(s);
  s.generatedAt += 30_000;
  const w = s.diagnostics.agentWorkflow;
  w.processes = [{ id: '10:1234', pid: 10, name: 'bun', state: 'S' }];
  w.activeJobs = [{ id: 'job-test-001', status: 'running', stale: true }];
  const start = await record(s);
  assert.ok(!start.events.some((e) => e.title.includes('process started')));
  assert.ok(start.events.some((e) => e.title.includes('heartbeat overdue')));
  s.generatedAt += 30_000;
  w.available = false; w.processes = []; w.jobsAvailable = false; w.activeJobs = [];
  assert.ok(!(await record(s)).events.some((e) => e.title.includes('process exited')));
  s.generatedAt += 30_000;
  w.available = true; w.jobsAvailable = true; w.recentJobs = [{ id: 'job-test-001', status: 'done', stale: false }];
  const finished = await record(s);
  assert.ok(!finished.events.some((e) => e.title.includes('process exited')));
  assert.ok(finished.events.some((e) => e.title.includes('job-test-001: done')));
});
