import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('dashboard renders diagnostics, escapes machine-supplied names, and retains readings on failure', async () => {
  const now = Date.now();
  const fixture = {
    generatedAt: now, supported: true, model: 'HP laptop', uptimeSec: 10000,
    power: { acOnline: true, batteries: [{ percent: 100, status: 'Full' }] }, temperatures: [], memory: { usedPct: 50, usedBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 },
    internet: { state: 'online', latencyMs: 50, networkName: '<img src=x onerror=alert(1)>', networkType: 'wifi', signalPct: 54, linkRate: '1170 Mbit/s' },
    services: [{ name: 'CLIProxyAPI', unit: 'cli.service', state: 'running', automaticRestarts: 0, startedAt: now - 1000 }],
    diagnostics: { memoryLevel: 'healthy', pressure: { cpu: null, memory: { some: { avg10: 0 } }, io: null },
      topProcesses: [{ pid: 12, name: '<script>bad()</script>', rssBytes: 1024 ** 3 }],
      disks: [{ name: 'T7 drive', path: '/mnt/nas', mounted: false, readOnly: null, usedPct: null }],
      backup: { state: 'failed', lastSuccessAt: now - 60_000, scheduleActive: true, nextRunAt: now + 3600_000 },
      tailscale: { state: 'running', connections: [{ type: 'direct', count: 1 }] },
      healthChecks: [{ service: 'cli.service', id: 'cli-health', label: 'Backend health', state: 'unhealthy', detail: 'HTTP 503', checkedAt: now, latencyMs: 10 }],
      agentWorkflow: { reason: 'Jobs active', pumpState: 'idle', timerActive: true, paused: false, staleCount: 1, lastTickAt: now,
        dailyPlans: { day: '2026-10-26', launched: 25, limit: 30, remaining: 5, resetsAt: now + 3600_000 },
        available: true, count: 1, cpuPct: 5.5, rssBytes: 1024 ** 3, truncated: false,
        processes: [{ pid: 44, ppid: 1, rootPid: 44, name: '<img src=process>', role: 'agentctl', command: 'heavy', state: 'S', cpuPct: 5.5, rssBytes: 1024 ** 3, elapsedSec: 12 }],
        jobsAvailable: true, activeCount: 1, partial: false, activeJobs: [{ id: 'job-test-001', status: 'running', stale: true, mode: 'implement', heartbeatAt: now - 600_000 }], recentJobs: [] } },
    history: { events: [{ title: '<img src=event>', timestamp: now, level: 'warning' }], samples: [{ timestamp: now - 30_000, state: 'online', latencyMs: 50 }, { timestamp: now, state: 'limited', latencyMs: null }], persisted: true },
  };
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: id === 'workspace-diagnostics', style: {}, setAttribute() {} });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {}, visibilityState: 'visible' },
    fetch: async (url) => ({ ok: true, json: async () => url.startsWith('/api/workspace') ? fixture : { generatedAt: now, accounts: [] } }),
    AbortSignal, setInterval() {}, setTimeout() {},
  });
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(context);
  await new Promise(setImmediate);
  assert.equal(element('workspace-diagnostics').hidden, false);
  const diagnostics = element('workspace-diagnostics').innerHTML;
  for (const label of ['Memory & processes', 'Storage & backup', 'Connection quality', 'Recent events', 'Not mounted', 'Last run failed', '1 direct connection', '1 of 2 internet checks unsuccessful', 'Agentctl & build-workflow', 'agentctl heavy', 'Heartbeat overdue', 'Pump idle']) assert.ok(diagnostics.includes(label), label);
  assert.ok(diagnostics.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!diagnostics.includes('<script>'));
  assert.ok(!diagnostics.includes('<img'));
  assert.ok(element('workspace-content').innerHTML.includes('&lt;img src=x'));
  assert.ok(element('workspace-content').innerHTML.includes('HTTP 503'));
  for (const label of ['Daily plans (UTC)', '25 / 30 launched today', '5 remaining', '00:00 UTC']) assert.ok(diagnostics.includes(label), label);
  vm.runInContext('workspace.diagnostics.agentWorkflow.dailyPlans = {launched:35,limit:30,remaining:0}; renderWorkspace();', context);
  assert.ok(element('workspace-diagnostics').innerHTML.includes('35 / 30 launched today'));
  assert.ok(element('workspace-diagnostics').innerHTML.includes('0 remaining · Daily limit reached'));
  assert.ok(element('workspace-diagnostics').innerHTML.includes('width:100%'));
  vm.runInContext('workspace.diagnostics.agentWorkflow.dailyPlans = {launched:0,limit:0,remaining:0}; renderWorkspace();', context);
  assert.ok(element('workspace-diagnostics').innerHTML.includes('0 / 0 launched today'));
  assert.ok(!element('workspace-diagnostics').innerHTML.includes('NaN'));
  vm.runInContext('workspace.diagnostics.agentWorkflow.dailyPlans = {launched:null,limit:30,remaining:null}; renderWorkspace();', context);
  assert.ok(element('workspace-diagnostics').innerHTML.includes('— / 30 launched today'));
  assert.ok(element('workspace-diagnostics').innerHTML.includes('Daily plan reading unavailable'));
  vm.runInContext('delete workspace.diagnostics.agentWorkflow.dailyPlans; renderWorkspace();', context);
  assert.ok(element('workspace-diagnostics').innerHTML.includes('— / — launched today'));
  vm.runInContext('workspace.diagnostics.agentWorkflow.available=false; workspace.diagnostics.agentWorkflow.processes=[]; workspace.diagnostics.agentWorkflow.jobsAvailable=false; renderWorkspace();', context);
  assert.ok(element('workspace-diagnostics').innerHTML.includes('Process readings unavailable'));
  assert.ok(element('workspace-diagnostics').innerHTML.includes('Job records unavailable'));
  vm.runInContext('workspaceError = true; renderWorkspace();', context);
  assert.equal(element('workspace-error').hidden, false);
  assert.ok(element('workspace-error').textContent.includes('Showing the last reading'));
  assert.equal(element('workspace-diagnostics').hidden, false);
  vm.runInContext('workspace = {supported:false}; workspaceError=false; renderWorkspace();', context);
  assert.equal(element('workspace-diagnostics').hidden, true);
});
