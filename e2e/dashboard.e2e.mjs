// Headless-Chromium checks of index.html against the real server, at phone and desktop width (see playwright.config.mjs).
// test/dashboard.test.mjs runs the page script against stub elements; these cover what only a browser shows:
// layout, focus, keyboard, tap, <details>, localStorage and following #workspace and #pipeline links.
//
// The server is createDashboardServer() with fake collectors that read `dash.state`, so no provider, agentctl or /proc
// reading happens. Any request that isn't to the test server is aborted and fails the test.
import { test as base, expect } from '@playwright/test';
import { createDashboardServer } from '../server.mjs';
import { createPipelineSettings } from '../pipeline-settings.mjs';
import { historyForApi, historySpan, incidentEpisodes, pruneEvents } from '../workspace-history.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORKSPACE_KEY = 'ai-quota-dashboard:workspace-details';
const PIPELINE_KEY = 'ai-quota-dashboard:pipeline-details';

// ---------- fake readings, relative to the real clock (the page uses it too) ----------
function quotasOf({ claudeUsed = 20 } = {}) {
  const now = Date.now();
  const account = (id, provider, name, plan, email, windows) => ({ id, provider, name, plan, email, sources: ['test'], fetchedAt: now, windows });
  return {
    generatedAt: now,
    accounts: [
      account('claude:a', 'claude', 'Claude', 'Max', 'claude-user@example.com', [
        { id: 'five_hour', label: '5-hour', usedPct: claudeUsed, resetsAt: now + 2.5 * HOUR, windowSec: 18_000 },
        { id: 'seven_day', label: 'Weekly', usedPct: 40, resetsAt: now + 3 * DAY, windowSec: 604_800 },
      ]),
      // A long address, to check that the phone layout wraps or clips it instead of scrolling sideways.
      account('openai:b', 'openai', 'ChatGPT', 'Plus', 'a-rather-long-address.for-the-phone-layout@example.com', [
        { id: 'primary', label: '5-hour', usedPct: 50, resetsAt: now + 2 * HOUR, windowSec: 18_000 },
        { id: 'secondary', label: 'Weekly', usedPct: 10, resetsAt: now + 5 * DAY, windowSec: 604_800 },
      ]),
      account('antigravity:c', 'antigravity', 'Antigravity', 'Pro', 'antigravity-user@example.com', [
        { id: 'gemini-pro', label: 'Gemini Pro', usedPct: 5, resetsAt: now + 4 * HOUR, windowSec: 18_000 },
      ]),
    ],
  };
}

function healthyWorkspace() {
  const now = Date.now();
  return {
    generatedAt: now, supported: true, model: 'HP laptop', uptimeSec: 3 * 86_400,
    power: { acOnline: true, batteries: [{ percent: 100, status: 'Full' }] },
    temperatures: [{ name: 'CPU', celsius: 50, criticalCelsius: 100 }],
    memory: { usedPct: 50, usedBytes: 6 * 1024 ** 3, totalBytes: 12 * 1024 ** 3, swapUsedBytes: 1024 ** 3 },
    internet: { state: 'online', latencyMs: 40, networkName: 'Home network', networkType: 'wifi', signalPct: 70, linkRate: '866 Mbit/s' },
    services: [
      { name: 'CLIProxyAPI', unit: 'cli.service', state: 'running', automaticRestarts: 0, startedAt: now - DAY },
      { name: 'T3 Code', unit: 't3code.service', state: 'running', automaticRestarts: 1, startedAt: now - 2 * DAY },
    ],
    diagnostics: {
      memoryLevel: 'healthy', pressure: { cpu: { some: { avg10: 1.5 } }, memory: { some: { avg10: 0 } }, io: { some: { avg10: 0.2 } } },
      topProcesses: [{ pid: 1234, name: 'node', rssBytes: 512 * 1024 ** 2 }],
      disks: [{ name: 'T7 drive', path: '/mnt/nas', mounted: true, readOnly: false, usedPct: 40, freeBytes: 600 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }],
      backup: { state: 'success', lastSuccessAt: now - HOUR, scheduleActive: true, nextRunAt: now + HOUR },
      tailscale: { state: 'running', connections: [{ type: 'direct', count: 2 }] },
      healthChecks: [{ service: 'cli.service', id: 'cli-health', label: 'Backend health', state: 'healthy', detail: 'OK', checkedAt: now, latencyMs: 5 }],
    },
    history: {
      events: [{ title: 'Internet back online', timestamp: now - HOUR, level: 'healthy' }],
      samples: [{ timestamp: now - 60_000, state: 'online', latencyMs: 45 }, { timestamp: now - 30_000, state: 'online', latencyMs: 40 }],
      persisted: true,
    },
    autoUpdate: { state: 'ok', timerActive: true, lastRunAt: now - 60_000, lastExitStatus: 0, nextRunAt: now + 600_000 },
  };
}

// The same reading with CLIProxyAPI's HTTP check failing: one critical condition.
function failingCheckWorkspace() {
  const ws = healthyWorkspace();
  ws.diagnostics.healthChecks[0] = { ...ws.diagnostics.healthChecks[0], state: 'unhealthy', detail: 'HTTP 503' };
  return ws;
}

function pipelineOf() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const slug = 'omertekin2002/example-repo';
  const url = `https://github.com/${slug}`;
  return {
    available: true, fetchedAt: now - 60_000, refreshMs: 300_000, error: null,
    overview: {
      version: 1, windowDays: 7, github: { available: true, errors: [], truncated: [] },
      attention: [{
        kind: 'decision', repo: slug, number: 12, url: `${url}/issues/12`, action: 'Answer it in the daily digest',
        title: '❓ Should the export include archived accounts that were removed more than ninety days ago?',
        options: ['Include them, marked as archived', 'Leave them out'], recommendation: 'Leave them out',
      }],
      repos: [{
        slug, url, available: true, defaultBranch: 'main', openPrCount: 1, vision: { number: 1, url: `${url}/issues/1` },
        attention: [{ kind: 'decision', repo: slug, number: 12, url: `${url}/issues/12`, title: '❓ Should the export include archived accounts?', action: 'Answer it in the daily digest' }],
        issues: {
          queued: [{ number: 14, title: 'A queued improvement with a fairly long title that has to wrap on a phone screen', url: `${url}/issues/14`, state: 'queued', queue: 'improvement', createdAt: iso(now - DAY) }],
          working: [], blocked: [], decision: [{ number: 12, title: '❓ Should the export include archived accounts?', url: `${url}/issues/12`, state: 'decision' }],
        },
        openPrs: [{ number: 15, title: 'feat: an improvement', url: `${url}/pull/15`, kind: 'improvement', issue: 13, head: 'agent/imp-13', base: 'agent/improvements', createdAt: iso(now - HOUR) }],
        jobs: { active: [], recent: [{ id: '20261101-0000-implement-example-13-abcd', mode: 'implement', issue: 13, status: 'done', finishedAt: iso(now - HOUR), summary: 'stacked: an improvement' }], recentCount: 1 },
        resolved: { issues: [], prs: [] }, stackedPrs: [],
      }],
    },
  };
}

// The same pipeline with nothing for the owner: no attention items and no decision waiting.
function quietPipeline() {
  const p = pipelineOf();
  p.overview.attention = [];
  p.overview.repos[0].attention = [];
  p.overview.repos[0].issues.decision = [];
  return p;
}

// ---------- fixtures ----------
const test = base.extend({
  // A dashboard server on a free port, and helpers for the page under test.
  dash: async ({ page, context }, use) => {
    const state = { quotas: quotasOf(), workspace: healthyWorkspace(), pipeline: pipelineOf(), failQuotas: false, maxPlansPerDay: 12, plansToday: 3 };
    const calls = { quotas: [], workspace: [], pipeline: [], agentctl: [] };
    const logged = [];
    const server = createDashboardServer({
      getQuotas: async (force) => {
        calls.quotas.push(force);
        if (state.failQuotas) throw new Error('fake quota collector failure');
        return state.quotas;
      },
      getWorkspaceStatus: async (force) => (calls.workspace.push(force), state.workspace),
      getPipelineOverview: async (force) => (calls.pipeline.push(force), state.pipeline),
      getVersion: () => ({ commit: '0123abc', startedAt: Date.now() - HOUR, restartNeeded: false, behindUpstream: false }),
      // The real settings module with a fake agentctl, so the request checks and validation run as in production.
      settings: createPipelineSettings({
        run: async (file, args) => {
          calls.agentctl.push(args);
          if (args[0] === 'set') state.maxPlansPerDay = Number(args[2]);
          const value = state.maxPlansPerDay;
          return JSON.stringify({ version: 1, day: new Date().toISOString().slice(0, 10), plansToday: state.plansToday,
            settings: { maxPlansPerDay: { value, configValue: 12, overridden: value !== 12, min: 0, max: 100, describe: 'plans' } } });
        },
      }),
      log: (...args) => logged.push(args.map(String).join(' ')),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    // Only the test server may be reached: no fonts, CDNs or provider APIs.
    const blocked = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      blocked.push(url);
      return route.abort('blockedbyclient');
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // Load the page and wait until all three readings are on screen.
    async function open(hash = '') {
      await page.goto(`${origin}/${hash}`);
      await settled();
    }
    async function settled() {
      await expect(page.locator('#glance-capacity')).not.toContainText('Loading');
      await expect(page.locator('#glance-workspace')).not.toContainText('Checking');
      await expect(page.locator('#glance-attention')).not.toContainText('Loading');
      await expect(page.locator('#refresh')).toBeEnabled();
    }
    // Press Refresh and wait for the whole refresh to finish.
    async function refresh() {
      const before = calls.quotas.length;
      await page.locator('#refresh').click();
      await expect.poll(() => calls.quotas.length).toBeGreaterThan(before);
      await expect(page.locator('#refresh')).toBeEnabled();
    }
    async function reload() {
      await page.reload();
      await settled();
    }
    const stored = (key = WORKSPACE_KEY) => page.evaluate((k) => localStorage.getItem(k), key);

    await use({ state, calls, logged, origin, open, refresh, reload, stored });

    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    expect(blocked, 'requests to anything but the test server').toEqual([]);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
  },
});

// A tap on a touch phone, a mouse click on the desktop.
const press = (locator, isMobile) => (isMobile ? locator.tap() : locator.click());

// The page itself must never scroll sideways, at any width.
async function expectNoSideScroll(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${innerWidth}px viewport`).toBeLessThanOrEqual(innerWidth);
}

const card = (page, email) => page.locator('.card').filter({ hasText: email });
const workspace = (page) => ({
  toggle: page.locator('#workspace-toggle'),
  content: page.locator('#workspace-content'),
  diagnostics: page.locator('#workspace-diagnostics'),
  meta: page.locator('#workspace-meta'),
});
async function expectWorkspaceOpen(page, open) {
  const ws = workspace(page);
  await expect(ws.toggle).toBeVisible();
  await expect(ws.toggle).toHaveAttribute('aria-expanded', String(open));
  await expect(ws.toggle).toContainText(open ? 'Hide details' : 'Show details');
  if (open) {
    await expect(ws.content).toBeVisible();
    await expect(ws.diagnostics).toBeVisible();
  } else {
    await expect(ws.content).toBeHidden();
    await expect(ws.diagnostics).toBeHidden();
  }
}

const pipeline = (page) => ({
  toggle: page.locator('#pipeline-toggle'),
  content: page.locator('#pipeline-content'),
  meta: page.locator('#pipeline-meta'),
});
async function expectPipelineOpen(page, open) {
  const p = pipeline(page);
  await expect(p.toggle).toBeVisible();
  await expect(p.toggle).toHaveAttribute('aria-expanded', String(open));
  await expect(p.toggle).toContainText(open ? 'Hide details' : 'Show details');
  if (open) await expect(p.content).toBeVisible();
  else await expect(p.content).toBeHidden();
}

// ---------- 1. healthy ----------
test('healthy: quota cards under At a glance, a one-line All OK workspace, no sideways scroll', async ({ page, dash }) => {
  await dash.open();
  await expect(page.locator('#overview')).toBeVisible();
  const glance = page.locator('#glance-capacity .glance-row');
  await expect(glance).toHaveCount(3);
  await expect(glance.first()).toContainText('Claude Max');
  await expect(page.locator('#glance-attention')).toContainText('1 item needs you');
  await expect(page.locator('#glance-workspace')).toHaveText('✓ All OK');

  // The cards come right after the strip, one per account, live.
  const cards = page.locator('#content .card');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('#content .win')).toHaveCount(5);
  await expect(card(page, 'claude-user@example.com').locator('.fresh')).toHaveText('● Live');
  const [stripBox, cardBox] = [await page.locator('#overview').boundingBox(), await cards.first().boundingBox()];
  expect(cardBox.y).toBeGreaterThanOrEqual(stripBox.y + stripBox.height);
  await expect(page.locator('#banner')).toBeEmpty();
  await expect(page.locator('#meta')).toContainText('running 0123abc');

  // Workspace computer: one summary line in the header, no readings below it.
  await expectWorkspaceOpen(page, false);
  await expect(workspace(page).meta).toContainText('✓ All OK · up 3d');

  // Agent pipeline: something needs the owner, so the panel is open, and the repo with it starts expanded.
  await expectPipelineOpen(page, true);
  const repo = page.locator('#pipeline details.repo');
  await expect(repo).toHaveCount(1);
  await expect(repo).toHaveAttribute('open', '');
  await expect(repo.locator('.repo-body')).toBeVisible();

  await expectNoSideScroll(page);
  // The same after opening everything there is to open.
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);
  for (const win of await page.locator('#content .win').all()) await win.click();
  await expect(page.locator('#content .win[aria-expanded="true"]')).toHaveCount(5);
  await expectNoSideScroll(page);
});

test('a Claude account with no 5-hour limit reported says so in a note on its card, without sideways scroll', async ({ page, dash }) => {
  const quotas = quotasOf();
  const claude = quotas.accounts[0];
  claude.windows = claude.windows.filter((w) => w.id !== 'five_hour');
  claude.noSessionLimit = true;
  dash.state.quotas = quotas;
  await dash.open();

  const claudeCard = card(page, 'claude-user@example.com');
  const note = claudeCard.locator('.card-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveText('No 5-hour limit reported by Anthropic for this account');
  await expect(claudeCard.locator('.win')).toHaveCount(1);
  await expect(claudeCard.locator('.win-label')).toHaveText(['Weekly']);
  await expect(page.locator('#content .card-note')).toHaveCount(1);
  // The note sits inside its card, below the windows.
  const [cardBox, noteBox, winBox] = [await claudeCard.boundingBox(), await note.boundingBox(), await claudeCard.locator('.win').boundingBox()];
  expect(noteBox.y).toBeGreaterThanOrEqual(winBox.y + winBox.height);
  expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  await expectNoSideScroll(page);
});

test('healthy: a repo closed in the Agent pipeline stays closed through a refresh', async ({ page, dash, isMobile }) => {
  await dash.open();
  const repo = page.locator('#pipeline details.repo');
  await press(repo.locator('summary'), isMobile);
  await expect(repo).not.toHaveAttribute('open');
  await expect(repo.locator('.repo-body')).toBeHidden();
  await dash.refresh();
  await expect(repo).not.toHaveAttribute('open');
  await press(repo.locator('summary'), isMobile);
  await expect(repo.locator('.repo-body')).toBeVisible();
  await expectNoSideScroll(page);
});

// ---------- 1b. Agent pipeline disclosure ----------
test('pipeline, nothing needs you: one summary line, Show details by keyboard, no sideways scroll either way', async ({ page, dash }) => {
  dash.state.pipeline = quietPipeline();
  await dash.open();
  await expect(page.locator('#glance-attention')).toHaveText('✓ Nothing needs you');
  await expectPipelineOpen(page, false);
  await expect(pipeline(page).meta).toHaveText('✓ Nothing needs you · 0 jobs running · 1 queued · 0 stacked in umbrellas');
  await expect(page.locator('#pipeline details.repo')).toBeHidden();
  await expect(page.locator('#pipeline .pipeline-totals')).toBeHidden();
  await expect(page.locator('#pipeline h3')).toHaveCount(2);
  for (const heading of await page.locator('#pipeline h3').all()) await expect(heading).toBeHidden();
  // The header is one line plus the summary: shorter than any panel with its body showing.
  const collapsed = (await page.locator('#pipeline').boundingBox()).height;
  expect(collapsed).toBeLessThan(140);
  await expectNoSideScroll(page);

  // Keyboard: the toggle is a real button, and its state is announced through aria-expanded.
  await pipeline(page).toggle.focus();
  await page.keyboard.press('Enter');
  await expectPipelineOpen(page, true);
  await expect(pipeline(page).toggle).toBeFocused();
  await expect(pipeline(page).meta).toContainText('1 repo in scope');
  await expect(page.locator('#pipeline details.repo')).toBeVisible();
  await expect(page.locator('#pipeline')).toContainText('Nothing needs you right now.');
  expect(await dash.stored(PIPELINE_KEY)).toBe('open');
  await expectNoSideScroll(page);
  await page.keyboard.press('Space');
  await expectPipelineOpen(page, false);
  expect(await dash.stored(PIPELINE_KEY)).toBe('closed');
  expect(await dash.stored(WORKSPACE_KEY), 'the Workspace choice is separate').toBeNull();
});

test('pipeline: the Show/Hide choice survives a reload, and a new attention item reopens a remembered close', async ({ page, dash }) => {
  dash.state.pipeline = quietPipeline();
  await dash.open();
  await expectPipelineOpen(page, false);
  await pipeline(page).toggle.click();
  await expectPipelineOpen(page, true);
  await dash.reload();
  await expectPipelineOpen(page, true);
  await pipeline(page).toggle.click();
  await expectPipelineOpen(page, false);
  await dash.reload();
  await expectPipelineOpen(page, false);

  // A decision arrives: the remembered close doesn't hide it.
  dash.state.pipeline = pipelineOf();
  await dash.refresh();
  await expectPipelineOpen(page, true);
  await expect(page.locator('#pipeline')).toContainText('Decisions to answer (1)');
  // Closed with the item on screen, the same item keeps it closed, and the summary counts it.
  await pipeline(page).toggle.click();
  await expectPipelineOpen(page, false);
  await dash.refresh();
  await expectPipelineOpen(page, false);
  await expect(pipeline(page).meta).toContainText('1 item needs you');
  await expectNoSideScroll(page);
  // After a reload the item is new to the page again.
  await dash.reload();
  await expectPipelineOpen(page, true);
  expect(await dash.stored(PIPELINE_KEY)).toBe('closed');
});

test('the glance tile’s Needs you link opens a collapsed pipeline panel, also when the URL already ends in #pipeline', async ({ page, dash, isMobile }) => {
  dash.state.pipeline = quietPipeline();
  await dash.open();
  await expectPipelineOpen(page, false);
  const link = page.locator('#overview a[href="#pipeline"]');
  await press(link, isMobile);
  await expectPipelineOpen(page, true);
  await expect(page).toHaveURL(/#pipeline$/);
  await expect(page.locator('#pipeline-title')).toBeInViewport();

  await pipeline(page).toggle.click();
  await expectPipelineOpen(page, false);
  await press(link, isMobile);
  await expectPipelineOpen(page, true);
  expect(await dash.stored(PIPELINE_KEY)).toBe('closed');

  await page.goto('about:blank');
  await dash.open('#pipeline');
  await expectPipelineOpen(page, true);
  await expectNoSideScroll(page);
});

// ---------- 2. window details ----------
test('window details open by tap or click, toggle by Enter and Space, close by Escape, and survive a refresh', async ({ page, dash, isMobile }) => {
  await dash.open();
  const claude = card(page, 'claude-user@example.com');
  const fiveHour = claude.locator('.win').nth(0);
  const weekly = claude.locator('.win').nth(1);
  const detailsOf = (win) => win.locator('.win-details');

  await expect(fiveHour).toHaveAttribute('aria-expanded', 'false');
  await expect(detailsOf(fiveHour)).toBeHidden();
  await press(fiveHour, isMobile);
  await expect(fiveHour).toHaveAttribute('aria-expanded', 'true');
  await expect(detailsOf(fiveHour)).toBeVisible();
  await expect(detailsOf(fiveHour)).toContainText('Left: 80%');
  await expect(detailsOf(fiveHour)).toContainText('Window: 5 hours');
  await expectNoSideScroll(page);

  // A refresh redraws every card with new numbers; the open window stays open and shows them.
  dash.state.quotas = quotasOf({ claudeUsed: 30 });
  await dash.refresh();
  await expect(detailsOf(fiveHour)).toContainText('Left: 70%');
  await expect(fiveHour).toHaveAttribute('aria-expanded', 'true');
  await expect(detailsOf(weekly)).toBeHidden();

  // Keyboard: focus stays on the window through each redraw, so the next key acts on it again.
  await weekly.focus();
  const scrolled = await page.evaluate(() => scrollY);
  await page.keyboard.press('Enter');
  await expect(weekly).toHaveAttribute('aria-expanded', 'true');
  await expect(detailsOf(weekly)).toContainText('Window: 7 days');
  await expect(weekly).toBeFocused();
  await page.keyboard.press(' ');
  await expect(weekly).toHaveAttribute('aria-expanded', 'false');
  await expect(weekly).toBeFocused();
  await page.keyboard.press(' ');
  await expect(weekly).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(weekly).toHaveAttribute('aria-expanded', 'false');
  await expect(detailsOf(weekly)).toBeHidden();
  await expect(weekly).toBeFocused();
  // Space didn't scroll the page, and Escape only closed the focused window.
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);
  await expect(fiveHour).toHaveAttribute('aria-expanded', 'true');

  // Tapping or clicking an open window closes it.
  await press(fiveHour, isMobile);
  await expect(fiveHour).toHaveAttribute('aria-expanded', 'false');
  await expect(detailsOf(fiveHour)).toBeHidden();
});

// ---------- 3. workspace warning ----------
test('workspace warning: a failed HTTP check opens the panel, the tile names it, and Hide/Show details toggles it', async ({ page, dash }) => {
  dash.state.workspace = failingCheckWorkspace();
  await dash.open();
  await expect(page.locator('#glance-workspace')).toContainText('⛔ 1 critical');
  await expect(page.locator('#glance-workspace')).toContainText('CLIProxyAPI check failed');
  await expectWorkspaceOpen(page, true);
  await expect(workspace(page).content).toContainText('Backend health: HTTP 503');
  await expect(workspace(page).content).toContainText('Check failed');
  await expectNoSideScroll(page);

  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, false);
  await expect(workspace(page).meta).toContainText('⛔ 1 critical');
  expect(await dash.stored()).toBe('closed');
  // The same condition on the next reading keeps it closed.
  await dash.refresh();
  await expectWorkspaceOpen(page, false);

  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);
  expect(await dash.stored()).toBe('open');
  await workspace(page).toggle.click();
  expect(await dash.stored()).toBe('closed');
  // After a reload the condition is new to the page again, and a remembered close never hides it.
  await dash.reload();
  await expectWorkspaceOpen(page, true);
  expect(await dash.stored()).toBe('closed');
});

test('workspace: the Show/Hide details choice survives a reload through localStorage', async ({ page, dash }) => {
  await dash.open();
  expect(await dash.stored()).toBeNull();
  await expectWorkspaceOpen(page, false);
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);
  expect(await dash.stored()).toBe('open');
  await dash.reload();
  await expectWorkspaceOpen(page, true);

  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, false);
  expect(await dash.stored()).toBe('closed');
  await dash.reload();
  await expectWorkspaceOpen(page, false);
});

// ---------- 3b. incidents ----------
test('incidents: the Incidents card lists an active and a recovered episode in text, before Recent events, without sideways scroll', async ({ page, dash }) => {
  const ws = healthyWorkspace(), now = Date.now(), MIN = 60_000;
  const ev = (timestamp, key, title, level = 'info') => ({ id: `${timestamp}:${key}:${title}`, timestamp, level, title });
  // Long machine-supplied titles, to check that they wrap on a phone.
  ws.history.events = [
    ev(now - 10 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'critical'),
    ev(now - 60 * MIN, 'ngrok-public', 'ngrok-proxy-llm · Public ngrok route (https://an-unusually-long-subdomain.ngrok-free.app/health): response recovered'),
    ev(now - 75 * MIN, 'ngrok-public', 'ngrok-proxy-llm · Public ngrok route (https://an-unusually-long-subdomain.ngrok-free.app/health): response failed', 'warning'),
  ];
  ws.history.episodes = incidentEpisodes(ws.history.events, now);
  dash.state.workspace = ws;
  await dash.open();
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);

  const incidents = page.locator('.incidents-card');
  await expect(incidents).toBeVisible();
  const rows = incidents.locator('li.incident');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Active: Memory pressure elevated or available RAM low');
  await expect(rows.nth(0)).toContainText('so far');
  await expect(rows.nth(1)).toContainText('Recovered: ngrok-proxy-llm · Public ngrok route');
  await expect(rows.nth(1)).toContainText('lasted 15m');
  await expect(incidents).toContainText('durations are approximate');
  // Incidents comes right before Recent events.
  const headings = await page.locator('#workspace-diagnostics h3').allTextContents();
  expect(headings.indexOf('Incidents')).toBe(headings.indexOf('Recent events') - 1);
  await incidents.scrollIntoViewIfNeeded();
  await expectNoSideScroll(page);

  dash.state.workspace = healthyWorkspace();
  dash.state.workspace.history.episodes = [];
  await dash.refresh();
  await expect(incidents).toContainText('No incidents in the last seven days');
});

test('incidents: a long history is served trimmed, counts every incident, and Recent events says how far back it goes', async ({ page, dash }) => {
  const ws = healthyWorkspace(), now = Date.now(), MIN = 60_000;
  const ev = (timestamp, key, title, level = 'info') => ({ id: `${timestamp}:${key}:${title}`, timestamp, level, title });
  // A day and seven hours of HTTP-check failures and recoveries, one pair every 20 minutes, through the server's own trimming.
  const events = pruneEvents(Array.from({ length: 186 }, (_, i) => {
    const t = now - (i + 1) * 10 * MIN, check = Math.floor(i / 2) % 3;
    return i % 2 ? ev(t, `check-${check}`, `Check ${check} · HTTP check: response failed`, 'warning') : ev(t, `check-${check}`, `Check ${check} · HTTP check: response recovered`);
  }), now);
  const startedAt = now - 31 * HOUR, serve = (droppedAt) => {
    ws.history = { ...ws.history, ...historyForApi({ events, episodes: incidentEpisodes(events, now), samples: [], startedAt, persisted: true, ...historySpan({ events, startedAt, droppedAt }, now) }) };
  };
  serve(null);
  expect(ws.history.events).toHaveLength(20);
  expect(ws.history.episodes).toHaveLength(20);
  dash.state.workspace = ws;
  await dash.open();
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);

  const incidents = page.locator('.incidents-card');
  await expect(incidents.locator('li.incident')).toHaveCount(10);
  await expect(incidents).toContainText('Showing 10 of 93 incidents.');
  const recent = page.locator('.diagnostic-card', { has: page.locator('h3', { hasText: 'Recent events' }) });
  await expect(recent.locator('li.event-row')).toHaveCount(10);
  await expect(recent).toContainText(/History since .+ \(1d 7h\) · kept for up to seven days\./);
  await expect(recent).not.toContainText('retained for seven days');
  await recent.scrollIntoViewIfNeeded();
  await expectNoSideScroll(page);

  // The cap dropped older events: the span starts at the oldest kept one and says why.
  serve(events.at(-1).timestamp - 1);
  dash.state.workspace = ws;
  await dash.refresh();
  await expect(recent).toContainText(/History since .+ \(1d 7h\) · older events dropped to stay within 1000 events\./);
  await expectNoSideScroll(page);
});

test('incidents: an incident opens to its recorded events by tap or keyboard, and stays open through a refresh', async ({ page, dash, isMobile }) => {
  const ws = healthyWorkspace(), now = Date.now(), MIN = 60_000;
  const ev = (timestamp, key, title, level = 'info') => ({ id: `${timestamp}:${key}:${title}`, timestamp, level, title });
  ws.history.events = [
    ev(now - 10 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'critical'),
    ev(now - 20 * MIN, 'boot', 'Computer restarted'),
    ev(now - 30 * MIN, 'memory', 'Memory pressure elevated or available RAM low', 'warning'),
    ev(now - 60 * MIN, 'ngrok-public', 'ngrok-proxy-llm · Public ngrok route (https://an-unusually-long-subdomain.ngrok-free.app/health): response recovered'),
    ev(now - 75 * MIN, 'ngrok-public', 'ngrok-proxy-llm · Public ngrok route (https://an-unusually-long-subdomain.ngrok-free.app/health): response failed', 'warning'),
    ev(now - 90 * MIN, 'oom', 'Linux killed a process because memory ran out', 'critical'),
  ];
  ws.history.episodes = incidentEpisodes(ws.history.events, now);
  dash.state.workspace = ws;
  await dash.open();
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);

  const incidents = page.locator('.incidents-card');
  const rows = incidents.locator('li.incident');
  await expect(rows).toHaveCount(3);
  const memory = rows.nth(0).locator('.incident-toggle'), ngrok = rows.nth(1).locator('.incident-toggle');
  const listOf = (row) => row.locator('.incident-events');
  // A one-off has no disclosure; the others start collapsed.
  await expect(rows.nth(2).locator('.incident-toggle')).toHaveCount(0);
  await expect(memory).toHaveAttribute('aria-expanded', 'false');
  await expect(listOf(rows.nth(0))).toBeHidden();
  await expect(memory).toHaveAttribute('aria-controls', await listOf(rows.nth(0)).getAttribute('id'));

  if (isMobile) {
    await memory.scrollIntoViewIfNeeded();
    await memory.tap();
    await expect(memory).toHaveAttribute('aria-expanded', 'true');
    await expect(listOf(rows.nth(0))).toBeVisible();
    await expect(listOf(rows.nth(0)).locator('li')).toHaveText([/Warning: Memory pressure elevated/, /Gap: Computer restarted/, /Critical: Memory pressure elevated/]);
    await ngrok.tap();
    await expect(listOf(rows.nth(1)).locator('li')).toHaveText([/Warning: ngrok-proxy-llm .* response failed/, /Info: ngrok-proxy-llm .* response recovered/]);
    await expectNoSideScroll(page);
    await incidents.screenshot({ path: test.info().outputPath('incident-open-phone.png') });
    // A second tap closes it.
    await ngrok.tap();
    await expect(ngrok).toHaveAttribute('aria-expanded', 'false');
  } else {
    await memory.focus();
    const scrolled = await page.evaluate(() => scrollY);
    await page.keyboard.press('Enter');
    await expect(memory).toHaveAttribute('aria-expanded', 'true');
    await expect(memory).toBeFocused();
    await expect(listOf(rows.nth(0))).toContainText('Gap: Computer restarted');
    await page.keyboard.press(' ');
    await expect(memory).toHaveAttribute('aria-expanded', 'false');
    await expect(memory).toBeFocused();
    await page.keyboard.press(' ');
    await expect(memory).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => scrollY)).toBe(scrolled);
    await ngrok.focus();
    await page.keyboard.press('Enter');
    await expect(ngrok).toHaveAttribute('aria-expanded', 'true');
    await incidents.screenshot({ path: test.info().outputPath('incident-open-desktop.png') });
    await page.keyboard.press('Escape');
    await expect(ngrok).toHaveAttribute('aria-expanded', 'false');
    await expect(listOf(rows.nth(1))).toBeHidden();
    await expect(ngrok).toBeFocused();
  }

  // A refresh with a newer reading redraws the card; the open incident stays open and shows the new event.
  const later = Date.now();
  ws.history.events.unshift(ev(later, 'memory', 'Memory pressure recovered'));
  ws.history.episodes = incidentEpisodes(ws.history.events, later);
  dash.state.workspace = ws;
  await dash.refresh();
  await expect(rows.nth(0)).toContainText('Recovered: Memory pressure elevated');
  const opened = rows.filter({ hasText: 'Recovered: Memory pressure elevated' });
  await expect(opened.locator('.incident-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(opened.locator('.incident-events li').last()).toContainText('Info: Memory pressure recovered');
});

// ---------- 4. #workspace link ----------
test('the glance tile’s Workspace link opens a collapsed panel, also when the URL already ends in #workspace', async ({ page, dash, isMobile }) => {
  await dash.open();
  await expectWorkspaceOpen(page, false);
  const link = page.locator('#overview a[href="#workspace"]');
  await press(link, isMobile);
  await expectWorkspaceOpen(page, true);
  await expect(page).toHaveURL(/#workspace$/);
  await expect(page.locator('#workspace-title')).toBeInViewport();

  // Collapse it again; following the link once more fires no hashchange but still opens it.
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, false);
  await press(link, isMobile);
  await expectWorkspaceOpen(page, true);
  // Following the link isn't a choice to remember: the owner's last one (closed) still stands.
  expect(await dash.stored()).toBe('closed');

  // Landing on /#workspace opens it too (from another page, so this is a full load, not a fragment change).
  await page.goto('about:blank');
  await dash.open('#workspace');
  await expectWorkspaceOpen(page, true);
  await expectNoSideScroll(page);
});

// ---------- 5. source failure ----------
test('a failing quota collector shows Couldn’t refresh and leaves the other panels working', async ({ page, dash }) => {
  dash.state.failQuotas = true;
  await dash.open();
  await expect(page.locator('#banner')).toContainText("Can't reach the quota server (HTTP 500)");
  await expect(page.locator('#glance-capacity')).toHaveText("⚠ Couldn't refresh");
  await expect(page.locator('#content .card')).toHaveCount(0);
  // The other readings arrived and still work.
  await expect(page.locator('#glance-workspace')).toHaveText('✓ All OK');
  await expect(page.locator('#glance-attention')).toContainText('1 item needs you');
  await expect(page.locator('#pipeline details.repo')).toHaveCount(1);
  await workspace(page).toggle.click();
  await expectWorkspaceOpen(page, true);
  await expectNoSideScroll(page);
  // The error text stays in the server log, never on the page.
  expect(dash.logged.some((line) => line.includes('/api/quotas') && line.includes('fake quota collector failure'))).toBe(true);
  await expect(page.locator('body')).not.toContainText('fake quota collector failure');
});

test('a quota refresh that fails after a good one keeps the last reading, marked, until a refresh works', async ({ page, dash, isMobile }) => {
  await dash.open();
  const claude = card(page, 'claude-user@example.com');
  await press(claude.locator('.win').first(), isMobile);
  await expect(claude.locator('.fresh')).toHaveText('● Live');

  dash.state.failQuotas = true;
  await dash.refresh();
  await expect(page.locator('#banner')).toContainText("Can't reach the quota server (HTTP 500). Showing the last reading.");
  await expect(page.locator('#meta')).toContainText("⚠ Couldn't refresh");
  await expect(page.locator('#glance-capacity')).toContainText("⚠ Couldn't refresh");
  await expect(page.locator('#content .card')).toHaveCount(3);
  await expect(claude.locator('.fresh')).toContainText('◷');
  await expect(claude.locator('.win').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#glance-workspace')).toHaveText('✓ All OK');
  await expectNoSideScroll(page);

  dash.state.failQuotas = false;
  await dash.refresh();
  await expect(page.locator('#banner')).toBeEmpty();
  await expect(page.locator('#meta')).not.toContainText("Couldn't refresh");
  await expect(claude.locator('.fresh')).toHaveText('● Live');
});

// ---------- Plans per day ----------
test('Plans per day: change the cap with the keyboard, see it saved and counted, without sideways scroll', async ({ page, dash }) => {
  await dash.open();
  const input = page.locator('#plans-per-day');
  const status = page.locator('#plans-status');
  await expect(input).toHaveValue('12');
  await expect(status).toContainText('3 of 12 launched today');
  await expect(page.locator('label[for="plans-per-day"]')).toBeVisible();
  await expectNoSideScroll(page);

  // Out of range: refused in the page, nothing sent to agentctl.
  await input.fill('150');
  await input.press('Enter');
  await expect(status).toContainText('Enter a whole number from 0 to 100');
  expect(dash.calls.agentctl.filter((a) => a[0] === 'set')).toEqual([]);

  await input.fill('5');
  await input.press('Enter');
  await expect(status).toContainText('Saved: 5 plans per day');
  await expect(status).toContainText('3 of 5 launched today');
  expect(dash.calls.agentctl.filter((a) => a[0] === 'set')).toEqual([['set', 'maxPlansPerDay', '5']]);

  // The cap survives a reload and the page says config.json differs.
  await dash.reload();
  await expect(input).toHaveValue('5');
  await expect(status).toContainText('config.json says 12');
  await expectNoSideScroll(page);
});

test('Plans per day: another site’s page can’t change the cap through the owner’s browser', async ({ page, dash }) => {
  await dash.open();
  // Same request the form sends, but as a cross-origin form post and as a fetch with a foreign Origin.
  const statuses = await page.evaluate(async () => {
    const asForm = await fetch('/api/pipeline/settings', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'maxPlansPerDay=40' });
    return [asForm.status];
  });
  expect(statuses).toEqual([415]);
  const foreign = await page.request.post(`${dash.origin}/api/pipeline/settings`, { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, data: { maxPlansPerDay: 40 } });
  expect(foreign.status()).toBe(403);
  expect(dash.calls.agentctl.filter((a) => a[0] === 'set')).toEqual([]);
});
