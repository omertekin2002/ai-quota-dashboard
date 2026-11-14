// Headless-Chromium checks of index.html against the real server, at phone and desktop width (see playwright.config.mjs).
// test/dashboard.test.mjs runs the page script against stub elements; these cover what only a browser shows:
// layout, focus, keyboard, tap, <details>, localStorage and following #workspace links.
//
// The server is createDashboardServer() with fake collectors that read `dash.state`, so no provider, agentctl or /proc
// reading happens. Any request that isn't to the test server is aborted and fails the test.
import { test as base, expect } from '@playwright/test';
import { createDashboardServer } from '../server.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORKSPACE_KEY = 'ai-quota-dashboard:workspace-details';

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

// ---------- fixtures ----------
const test = base.extend({
  // A dashboard server on a free port, and helpers for the page under test.
  dash: async ({ page, context }, use) => {
    const state = { quotas: quotasOf(), workspace: healthyWorkspace(), pipeline: pipelineOf(), failQuotas: false };
    const calls = { quotas: [], workspace: [], pipeline: [] };
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
    const stored = () => page.evaluate((key) => localStorage.getItem(key), WORKSPACE_KEY);

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

  // Agent pipeline: the repo with something for the owner starts expanded.
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
