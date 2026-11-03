import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const pageScript = new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

// Run index.html's script in a vm with stub DOM elements and canned API replies.
// Pass `now` to pin Date (and Date.now) inside the page, so durations and percentages are deterministic.
// `respond(url, init)` may return a reply (or a promise of one) to override the canned reply for that request.
// `AbortSignal.timeout(ms)` never fires on its own: `expire(ms)` aborts the pending signals made with that delay.
// Pass `abortSignalTimeout: false` for a browser without it (Safari before 16).
// `setTimeout` never fires on its own either: `timers` holds each callback with its delay, and `timeouts` just the delays.
// `setInterval` callbacks are kept in `intervals` the same way; `tick()` fires the 15-second clock update.
// `document.elementFromPoint` answers null (the pointer is over nothing) until a test replaces it.
// `media.fine` is what `matchMedia('(hover: hover) and (pointer: fine)')` answers: a mouse or trackpad.
async function loadDashboard({ quotas = { generatedAt: Date.now(), accounts: [] }, workspace = { supported: false }, pipeline = {}, version = null, now, hidden = () => false, respond, abortSignalTimeout = true } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '', textContent: '', hidden: hidden(id), style: {}, setAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 200, height: 100 }),
        querySelectorAll(selector) { return selector === '.win' ? winElements(this.innerHTML) : []; },
      });
    }
    return elements.get(id);
  }
  // Stub `.win` elements for the windows rendered in `html`, read from their attributes.
  function winElements(html) {
    return [...html.matchAll(/<div class="win"[^>]*>/g)].map(([tag]) => {
      const attr = (name) => { const m = tag.match(new RegExp(` ${name}="([^"]*)"`)); return m && unescapeHtml(m[1]); };
      const el = {
        tag, getAttribute: attr, dataset: { a: attr('data-a'), w: attr('data-w'), key: attr('data-key') },
        closest: (selector) => (selector === '.win' ? el : null), matches: (selector) => selector === '.win',
        focus: () => { document.activeElement = el; },
      };
      return el;
    });
  }
  const listeners = {};
  const timeouts = [];
  const timers = []; // { fn, ms } for each setTimeout
  const intervals = []; // { fn, ms } for each setInterval
  const signals = []; // { ms, controller } for each AbortSignal.timeout the page asked for
  const expire = (ms) => {
    for (const s of signals) {
      if (s.ms === ms && !s.controller.signal.aborted) s.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }
  };
  const document = {
    getElementById: element, visibilityState: 'visible', title: '', activeElement: null, elementFromPoint: () => null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const media = { fine: true };
  const globals = {
    document,
    // `version: null` answers /api/version with a 404, like a server from before it existed.
    fetch: async (url, init) => respond?.(url, init) ?? (url.startsWith('/api/version')
      ? { ok: version != null, status: version != null ? 200 : 404, json: async () => version }
      : { ok: true, json: async () => (url.startsWith('/api/quotas') ? quotas : url.startsWith('/api/workspace') ? workspace : pipeline) }),
    AbortSignal: abortSignalTimeout ? { timeout: (ms) => { const controller = new AbortController(); signals.push({ ms, controller }); return controller.signal; } } : {},
    AbortController,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); }, innerWidth: 1280, innerHeight: 800,
    matchMedia: (query) => ({ matches: query === '(hover: hover) and (pointer: fine)' && media.fine }),
    setTimeout: (fn, ms) => { timeouts.push(ms); timers.push({ fn, ms }); return timeouts.length; },
  };
  if (now != null) {
    globals.Date = class extends Date {
      constructor(...args) { if (args.length) super(...args); else super(now); }
      static now() { return now; }
    };
  }
  const context = vm.createContext(globals);
  pageScript.runInContext(context);
  await new Promise(setImmediate);
  // Fire a document event the way the browser would, and return it (to check `defaultPrevented`).
  const dispatch = (type, fields) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const fn of listeners[type] || []) fn(event);
    return event;
  };
  // The rendered window `wi` of account `ai`, as a stub element.
  const winEl = (ai, wi) => winElements(element('content').innerHTML).find((el) => el.dataset.a === String(ai) && el.dataset.w === String(wi));
  // Hover window `wi` of account `ai`, the way a pointer would, and return the tooltip's HTML.
  const hover = (ai, wi, pointerType = 'mouse') => {
    dispatch('pointermove', { target: winEl(ai, wi), pointerType, clientX: 10, clientY: 10 });
    return element('tip').innerHTML;
  };
  const click = (el) => dispatch('click', { target: el });
  const press = (el, key, fields = {}) => dispatch('keydown', { target: el, key, ...fields });
  return { context, document, element, media, listeners, timeouts, timers, intervals, tick: () => intervals.find((i) => i.ms === 15_000).fn(), signals, expire, dispatch, winEl, hover, click, press, run: (code) => vm.runInContext(code, context) };
}

const unescapeHtml = (s) => s.replace(/&(quot|#39|lt|gt|amp);/g, (_, e) => ({ quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' })[e]);

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
  const { context, element } = await loadDashboard({
    quotas: { generatedAt: now, accounts: [] }, workspace: fixture, hidden: (id) => id === 'workspace-diagnostics',
  });
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

test('dashboard shows unreadable usage as unknown, never as 100% left', async () => {
  const now = Date.now();
  const quotas = { generatedAt: now, accounts: [
    { id: 'claude:a', provider: 'claude', name: 'Claude', plan: 'Pro', email: 'a@example.com', sources: ['Claude Code'], windows: [
      { id: 'five_hour', label: '5-hour', usedPct: 60, resetsAt: now + 3600_000, windowSec: 18000 },
      { id: 'seven_day', label: 'Weekly', usedPct: null, resetsAt: now + 86400_000, windowSec: 604800 },
    ] },
    { id: 'openai:b', provider: 'openai', name: 'ChatGPT', plan: 'Plus', email: 'b@example.com', sources: ['Codex CLI'], windows: [
      { id: 'primary', label: '5-hour', usedPct: null, resetsAt: now + 3600_000, windowSec: 18000 },
    ] },
  ] };
  const { context, document, element } = await loadDashboard({ quotas });

  const cards = element('content').innerHTML;
  const wins = cards.split('class="win"').slice(1);
  assert.equal(wins.length, 3);
  assert.ok(wins[0].includes('40%') && wins[0].includes('5-hour: 40 percent left'));
  for (const win of wins.slice(1)) {
    assert.ok(win.includes('<span class="big">—</span>'), win);
    assert.ok(win.includes('Usage unknown'), win);
    assert.ok(win.includes('usage unknown, resets in'), win);
    assert.ok(!win.includes('class="fill"') && !win.includes('class="status') && !win.includes('At this pace'), win);
  }
  assert.equal(document.title, '40% · Quotas');

  vm.runInContext('tableView = true; render();', context);
  const table = element('content').innerHTML;
  const rows = table.split('<tr>').slice(2);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('40%') && rows[0].includes('60%') && rows[0].includes('OK'));
  for (const row of rows.slice(1)) {
    assert.equal(row.match(/<td class="num">—<\/td>/g).length, 2, row);
    assert.ok(row.includes('Usage unknown'), row);
  }
  for (const text of [cards, table, document.title]) {
    for (const bad of ['NaN', 'null', 'undefined', '100%']) assert.ok(!text.includes(bad), `${bad} in ${text}`);
  }

  // Once the reset time passes, the window has refilled, so the estimate is 100% left again.
  vm.runInContext(`data.accounts[1].windows[0].resetsAt = ${now - 1000}; tableView = false; render();`, context);
  assert.ok(element('content').innerHTML.includes('Estimated. Refreshing…'));
  assert.equal(document.title, '40% · 100% · Quotas');
});

// Quota card fixtures. The page clock is pinned to NOW, so nothing below depends on the real clock.
// Clock-of-day text (fmtClock / fmtFull) depends on the time zone, so it is never asserted.
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const win = (label, usedPct, toResetSec, windowSec = FIVE_HOURS, extra = {}) => ({
  id: label.toLowerCase(), label, usedPct, resetsAt: NOW + toResetSec * 1000, windowSec, ...extra,
});
const account = (id, windows, extra = {}) => ({
  id, provider: 'claude', name: 'Claude', plan: 'Max', email: 'a@example.com', sources: ['Claude Code'], fetchedAt: NOW, windows, ...extra,
});
const quotasOf = (...accounts) => ({ generatedAt: NOW, accounts });
const cardsOf = (html) => html.split('<article class="card">').slice(1);
const winsOf = (html) => html.split('class="win"').slice(1);
const tableRowsOf = (html) => html.split('<tr>').slice(2);
const TAGS = 'div|span|article|header|code|table|thead|tbody|tr|th|td|br';

// Rendered output never shows a broken value, and every `<` opens one of the page's own tags.
function assertClean(text) {
  for (const bad of ['NaN', 'undefined', 'null', 'width:-', 'left:-']) assert.ok(!text.includes(bad), `${bad} in ${text}`);
  const stray = text.match(new RegExp(`<(?!/?(?:${TAGS})[\\s>])`));
  assert.equal(stray, null, `unescaped < in ${text}`);
}

async function renderQuotas(quotas) {
  const page = await loadDashboard({ quotas, now: NOW });
  const cards = page.element('content').innerHTML;
  page.run('tableView = true; render();');
  const table = page.element('content').innerHTML;
  page.run('tableView = false; render();');
  assertClean(cards);
  assertClean(table);
  return { ...page, cards, table };
}

test('Antigravity renders grouped quotas and unknown reset cadence in cards, table and capacity', async () => {
  const page = await renderQuotas(quotasOf(account('antigravity:a', [
    win('Gemini · 5-hour', 25, 9000),
    win('Claude & GPT (shared) · Weekly', 80, 302_400, WEEK),
    { id: 'legacy', label: 'Gemini · Reported quota', usedPct: 10, resetsAt: null, windowSec: null, resetUnknown: true },
  ], { provider: 'antigravity', name: 'Antigravity', plan: null, sources: ['T3 Code'] })));
  assert.ok(page.cards.includes('mono antigravity') && page.cards.includes('✦'));
  assert.ok(page.cards.includes('Read from T3 Code'));
  assert.ok(page.cards.includes('Claude &amp; GPT (shared) · Weekly'));
  assert.ok(page.element('glance-capacity').innerHTML.includes('Antigravity'));
  for (const output of [page.cards, page.table]) {
    assert.ok(output.includes('Reset time unavailable'));
    assert.ok(!output.includes('resets with billing cycle'));
  }
  assert.ok(!winsOf(page.cards)[2].includes('class="pace"'));
});

test('quota cards project the pace, warn before running out, and place the time-left tick', async () => {
  const { cards, hover } = await renderQuotas(quotasOf(account('claude:a', [
    win('Half', 30, 9000), // halfway, 30% used: 30% more by the reset, so about 40% left
    win('Heavy', 60, 9000), // halfway, 60% used: 40% left lasts 40 / (60 / 9000s) = 6000s
    win('Weekly', 10, 151_200, WEEK), // a quarter of the week left: 10% used + 3.3% more, about 87% left
  ])));
  const [half, heavy, weekly] = winsOf(cards);
  assert.ok(half.includes('<span class="big">70%</span>'), half);
  assert.ok(half.includes('<div class="fill" style="width:70%"></div>'), half);
  assert.ok(half.includes('<div class="pace" style="left:50%"></div>'), half);
  assert.ok(half.includes('resets in 2h 30m · '), half);
  assert.ok(half.includes('<div class="win-foot ">At this pace, about 40% left at reset</div>'), half);
  assert.ok(!half.includes('class="status'), half);

  assert.ok(heavy.includes('<div class="win-foot warn">⚠ At this pace it runs out in 1h 40m, before the reset</div>'), heavy);
  assert.ok(!heavy.includes('left at reset'), heavy);

  assert.ok(weekly.includes('<div class="pace" style="left:25%"></div>'), weekly);
  assert.ok(weekly.includes('At this pace, about 87% left at reset'), weekly);
  assert.ok(weekly.includes('resets in 1d 18h · '), weekly);
  assert.ok(hover(0, 2).includes('<span class="k">Time left:</span> 25% of window'));
});

test('quota cards show no projection very early in a window or before any use', async () => {
  const { cards } = await renderQuotas(quotasOf(account('claude:a', [
    win('Early', 5, 17_800), // 200s of 18000s elapsed (1.1%): too early to project
    win('Idle', 0, 9000), // halfway with nothing used
  ])));
  const [early, idle] = winsOf(cards);
  assert.ok(early.includes('<div class="win-foot "></div>'), early);
  assert.ok(early.includes(`<div class="pace" style="left:${(17_800 / FIVE_HOURS) * 100}%"></div>`), early);
  assert.ok(idle.includes('<div class="win-foot "></div>'), idle);
  assert.ok(idle.includes('<div class="fill" style="width:100%"></div>'), idle);
  assert.ok(idle.includes('<div class="pace" style="left:50%"></div>'), idle);
  assert.ok(idle.includes('resets in 2h 30m · '), idle);
  assert.ok(!cards.includes('At this pace'), cards);
});

test('a window that has not started says so and draws no time-left tick', async () => {
  const { cards, hover } = await renderQuotas(quotasOf(account('claude:a', [win('5-hour', 0, FIVE_HOURS - 30)])));
  const [fresh] = winsOf(cards);
  assert.ok(fresh.includes('<span class="win-reset">starts on first use</span>'), fresh);
  assert.ok(fresh.includes('<div class="win-foot ">Unused. The window starts when you send your first request.</div>'), fresh);
  assert.ok(fresh.includes('<div class="fill" style="width:100%"></div>'), fresh);
  assert.ok(!fresh.includes('class="pace"'), fresh);
  assert.ok(fresh.includes('aria-label="5-hour: 100 percent left, starts on first use"'), fresh);
  const tip = hover(0, 0);
  assert.ok(!tip.includes('Resets:') && !tip.includes('Time left:'), tip);
});

test('quota levels: Low at 30% left, Nearly out at 10%, Limit reached at 0% with clamping', async () => {
  const { cards, table } = await renderQuotas(quotasOf(account('claude:a', [
    win('Fine', 69, 9000),
    win('Low', 70, 9000),
    win('Low edge', 89, 9000),
    win('Nearly', 90, 9000),
    win('Empty', 100, 9000),
    win('Over', 120, 9000),
  ])));
  const [fine, low, lowEdge, nearly, empty, over] = winsOf(cards);
  assert.ok(fine.includes('<div class="meter " aria-hidden="true">') && !fine.includes('class="status'), fine);
  for (const [w, left] of [[low, 30], [lowEdge, 11]]) {
    assert.ok(w.includes('<span class="status warning">⚠ Low</span>'), w);
    assert.ok(w.includes('<div class="meter warning" aria-hidden="true">'), w);
    assert.ok(w.includes(`<span class="big">${left}%</span>`), w);
  }
  assert.ok(nearly.includes('<span class="status critical">⛔ Nearly out</span>'), nearly);
  assert.ok(nearly.includes('<div class="meter critical" aria-hidden="true">'), nearly);
  for (const w of [empty, over]) {
    assert.ok(w.includes('<span class="status critical">⛔ Limit reached</span>'), w);
    assert.ok(w.includes('<div class="meter critical" aria-hidden="true">'), w);
    assert.ok(w.includes('<span class="big">0%</span>'), w);
    assert.ok(w.includes('<div class="fill" style="width:0%"></div>'), w);
  }
  assert.ok(over.includes('aria-label="Over: 0 percent left, '), over);

  const rows = tableRowsOf(table);
  assert.equal(rows.length, 6);
  assert.ok(rows[0].includes('<td class="num">31%</td>') && rows[0].includes('<td>OK</td>'), rows[0]);
  assert.ok(rows[1].includes('<td>⚠ Low</td>'), rows[1]);
  assert.ok(rows[3].includes('<td>⛔ Nearly out</td>'), rows[3]);
  assert.match(rows[5], /<td class="num">0%<\/td>\s*<td class="num">120%<\/td>/);
  assert.ok(rows[5].includes('<td>⛔ Limit reached</td>'), rows[5]);
});

test('billing-cycle windows say so and draw no time-left tick', async () => {
  const { cards, table, hover } = await renderQuotas(quotasOf(account('claude:a', [{ id: 'credits', label: 'Monthly', usedPct: 25 }])));
  const [monthly] = winsOf(cards);
  assert.ok(monthly.includes('<span class="win-reset">resets with billing cycle</span>'), monthly);
  assert.ok(monthly.includes('<div class="fill" style="width:75%"></div>'), monthly);
  assert.ok(!monthly.includes('class="pace"') && !monthly.includes('At this pace'), monthly);
  assert.ok(tableRowsOf(table)[0].includes('<td>resets with billing cycle</td>'), table);
  const tip = hover(0, 0);
  assert.ok(tip.includes('<span class="k">Window:</span> n/a'), tip);
  assert.ok(!tip.includes('Resets:') && !tip.includes('Time left:'), tip);
});

test('stale accounts show their reading age, put the error first, and never promise a refresh', async () => {
  const stale = account('claude:old', [win('5-hour', 40, -60), win('Weekly', 50, 86_400, WEEK)], {
    stale: true, fetchedAt: NOW - 3_600_000, error: 'Token expired. Run `claude` to sign in again.',
  });
  const live = account('openai:b', [win('5-hour', 20, 9000)], { provider: 'openai', name: 'ChatGPT', plan: 'Plus', email: 'b@example.com' });
  const failing = account('openai:c', [win('5-hour', 20, 9000)], { provider: 'openai', name: 'ChatGPT', plan: 'Pro', error: 'HTTP 500 from usage endpoint' });
  const page = await renderQuotas(quotasOf(stale, live, failing));
  const [staleCard, liveCard, failingCard] = cardsOf(page.cards);

  assert.ok(staleCard.includes('◷ 1h ago</span>') && !staleCard.includes('● Live'), staleCard);
  assert.ok(staleCard.includes('title="Token expired. Run `claude` to sign in again. Read from Claude Code"'), staleCard);
  const err = staleCard.indexOf('<div class="card-error">Showing the last reading. Token expired. Run <code>claude</code> to sign in again.</div>');
  assert.ok(err > 0 && err < staleCard.indexOf('class="win"'), staleCard);
  assert.ok(liveCard.includes('● Live') && !liveCard.includes('card-error'), liveCard);
  // A failing account with no last reading: no badge, and the error comes after its windows.
  assert.ok(!failingCard.includes('class="fresh'), failingCard);
  assert.ok(failingCard.indexOf('<div class="card-error">HTTP 500 from usage endpoint</div>') > failingCard.indexOf('class="win"'), failingCard);
  assert.ok(!failingCard.includes('Showing the last reading'), failingCard);

  // The stale window's reset has passed: it estimates 100% left, but no reload is scheduled, so no "Refreshing…".
  const [passed] = winsOf(staleCard);
  assert.ok(passed.includes('<span class="big">100%</span>'), passed);
  assert.ok(passed.includes('<span class="win-reset">reset since last reading</span>'), passed);
  assert.ok(passed.includes('<div class="win-foot ">Estimated: reset since this reading</div>'), passed);
  assert.ok(!page.cards.includes('Refreshing'), page.cards);
  assert.deepEqual(page.timeouts, []);

  const rows = tableRowsOf(page.table);
  assert.equal(rows.length, 4);
  for (const row of rows.slice(0, 2)) assert.ok(row.includes(' (reading from 1h ago)</td>'), row);
  for (const row of rows.slice(2)) assert.ok(!row.includes('reading from'), row);

  const tip = page.hover(0, 1);
  assert.ok(tip.includes('<span class="k">Reading:</span> from 1h ago'), tip);
  assertClean(tip);

  // The same reading from a live account still says it is refreshing, and schedules the 20-second reload.
  page.run('data.accounts[0].stale = false; render();');
  assert.ok(winsOf(cardsOf(page.element('content').innerHTML)[0])[0].includes('Estimated. Refreshing…'));
  assert.deepEqual(page.timeouts, [20_000]);
});

test('quota cards, table and tooltip escape account and window strings', async () => {
  const evil = {
    name: '<img src=x onerror=alert(1)>', plan: '"><script>p()</script>', email: `o'neil"<b>@example.com`,
    error: '<img src=err> run `codex login` "now"',
  };
  const windows = [win('<img src=label>', 20, 9000), win(`Week"'<i>`, 10, 86_400, WEEK)];
  const page = await renderQuotas(quotasOf(
    account('claude:evil', windows, evil),
    account('claude:evil-stale', windows, { ...evil, stale: true, fetchedAt: NOW - 120_000 }),
  ));
  const tips = [page.hover(0, 0), page.hover(0, 1), page.hover(1, 0)];
  for (const text of [page.cards, page.table, ...tips]) {
    assertClean(text);
    for (const raw of ['<img', '<script', '<b>', '<i>', `"'`]) assert.ok(!text.includes(raw), `${raw} in ${text}`);
  }
  for (const text of [page.cards, page.table]) {
    for (const escaped of ['&lt;img src=x onerror=alert(1)&gt;', '&quot;&gt;&lt;script&gt;p()&lt;/script&gt;', 'o&#39;neil&quot;&lt;b&gt;@example.com', '&lt;img src=label&gt;', 'Week&quot;&#39;&lt;i&gt;']) {
      assert.ok(text.includes(escaped), `${escaped} missing from ${text}`);
    }
  }
  // Backticks in errors still render as code; everything else in the error is escaped.
  assert.ok(page.cards.includes('<div class="card-error">&lt;img src=err&gt; run <code>codex login</code> &quot;now&quot;</div>'), page.cards);
  assert.ok(page.cards.includes('<div class="card-error">Showing the last reading. &lt;img src=err&gt; run <code>codex login</code> &quot;now&quot;</div>'), page.cards);
  assert.ok(page.cards.includes('title="&lt;img src=err&gt; run `codex login` &quot;now&quot; Read from Claude Code"'), page.cards);
  assert.ok(tips[0].includes('<span class="k">&lt;img src=x onerror=alert(1)&gt; &quot;&gt;&lt;script&gt;p()&lt;/script&gt;:</span> &lt;img src=label&gt;'), tips[0]);
  assert.ok(tips[1].includes('Week&quot;&#39;&lt;i&gt;'), tips[1]);
});

test('the tooltip lists exact numbers for a window, plus its share of the weekly limit', async () => {
  const page = await renderQuotas(quotasOf(account('claude:a', [
    win('5-hour', 30, 9000),
    win('Opus', 40, 302_400, WEEK, { shareOfWeeklyPct: 25 }),
  ])));
  const tip = page.hover(0, 0);
  const rows = [...tip.matchAll(/<div><span class="k">([^<]*):<\/span> ([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows.map(([k]) => k), ['Claude Max', 'Left', 'Used', 'Window', 'Resets', 'Time left']);
  assert.deepEqual(Object.fromEntries(rows.filter(([k]) => k !== 'Resets')), {
    'Claude Max': '5-hour', Left: '70%', Used: '30%', Window: '5 hours', 'Time left': '50% of window',
  });
  assert.ok(rows[4][1].length > 0, tip);

  const share = page.hover(0, 1);
  assert.ok(share.includes('<div><span class="k">Window:</span> 7 days</div><div><span class="k">Allowance:</span> 25% of the weekly limit</div>'), share);
  assert.ok(share.includes('<span class="k">Time left:</span> 50% of window'), share);
  for (const text of [tip, share]) assertClean(text);
});

// A rendered window's details block: whether it is hidden, and its contents.
function detailsOf(html, id) {
  const m = html.match(new RegExp(`<div class="win-details" id="${id}"( hidden)?>([\\s\\S]*?)</div>\\s+</div>`)); // rows are joined with no space between them
  assert.ok(m, `no details block ${id} in ${html}`);
  return { hidden: !!m[1], html: m[2] };
}
const expanded = (page) => winsOf(page.element('content').innerHTML).map((w) => w.match(/aria-expanded="(true|false)"/)[1] === 'true');

test('a window is a button that opens its details inline by click or tap, and only that window', async () => {
  const page = await renderQuotas(quotasOf(
    account('claude:a', [win('5-hour', 30, 9000), win('Weekly', 40, 302_400, WEEK, { shareOfWeeklyPct: 25 })]),
    account('openai:b', [win('5-hour', 20, 9000)], { provider: 'openai', name: 'ChatGPT', plan: 'Plus' }),
  ));
  const { element, winEl, click, run } = page;
  const html = () => element('content').innerHTML;
  for (const [ai, wi] of [[0, 0], [0, 1], [1, 0]]) {
    const el = winEl(ai, wi);
    assert.equal(el.getAttribute('role'), 'button');
    assert.equal(el.getAttribute('tabindex'), '0');
    assert.equal(el.getAttribute('aria-expanded'), 'false');
    assert.equal(el.getAttribute('aria-controls'), `win-${ai}-${wi}-details`);
    assert.equal(el.getAttribute('aria-describedby'), null);
    assert.deepEqual(detailsOf(html(), `win-${ai}-${wi}-details`), { hidden: true, html: '' });
  }
  assert.equal(winsOf(html()).filter((w) => w.includes('<span class="win-more" aria-hidden="true">▸ Details</span>')).length, 3);

  click(winEl(0, 1));
  assert.deepEqual(expanded(page), [false, true, false]);
  const opened = winEl(0, 1);
  assert.equal(opened.getAttribute('aria-describedby'), 'win-0-1-details');
  const details = detailsOf(html(), 'win-0-1-details');
  assert.equal(details.hidden, false);
  // The same rows the hover tooltip shows, built by the same function.
  assert.equal(details.html, run('tipHtml(data.accounts[0], data.accounts[0].windows[1], view(data.accounts[0].windows[1], Date.now()))'));
  for (const row of ['<span class="k">Used:</span> 40%', '<span class="k">Window:</span> 7 days', '<span class="k">Allowance:</span> 25% of the weekly limit', '<span class="k">Time left:</span> 50% of window']) {
    assert.ok(details.html.includes(row), row);
  }
  assert.ok(winsOf(html())[1].includes('▾ Details'), winsOf(html())[1]);
  assert.equal(detailsOf(html(), 'win-0-0-details').hidden, true);
  assertClean(html());

  click(winEl(1, 0));
  assert.deepEqual(expanded(page), [false, true, true]);
  click(winEl(0, 1));
  assert.deepEqual(expanded(page), [false, false, true]);
  assert.deepEqual(detailsOf(html(), 'win-0-1-details'), { hidden: true, html: '' });

  // Finishing a text selection inside a window doesn't toggle it.
  run('globalThis.getSelection = () => "Used: 20%"');
  click(winEl(1, 0));
  assert.deepEqual(expanded(page), [false, false, true]);
});

test('Enter and Space toggle a focused window, Escape collapses it, and focus stays on that window', async () => {
  const page = await renderQuotas(quotasOf(account('claude:a', [win('5-hour', 30, 9000), win('Weekly', 40, 302_400, WEEK)])));
  const { document, winEl, press } = page;
  winEl(0, 1).focus();
  const focusedKey = () => document.activeElement?.dataset.key;
  const key = winEl(0, 1).dataset.key;

  let e = press(winEl(0, 1), 'Enter');
  assert.ok(e.defaultPrevented);
  assert.deepEqual(expanded(page), [false, true]);
  // render() replaced the element; focus moved to the new one for the same window.
  assert.equal(focusedKey(), key);
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'true');

  e = press(winEl(0, 1), 'Escape');
  assert.ok(e.defaultPrevented);
  assert.deepEqual(expanded(page), [false, false]);
  assert.equal(focusedKey(), key);

  e = press(winEl(0, 1), ' ');
  assert.ok(e.defaultPrevented, 'Space must not scroll the page');
  assert.deepEqual(expanded(page), [false, true]);
  assert.equal(focusedKey(), key);
  e = press(winEl(0, 1), ' ', { repeat: true }); // holding Space doesn't flicker it
  assert.ok(e.defaultPrevented);
  assert.deepEqual(expanded(page), [false, true]);
  e = press(winEl(0, 1), ' ');
  assert.deepEqual(expanded(page), [false, false]);

  // Escape on a collapsed window, other keys, and shortcuts are left to the browser.
  for (const [k, fields] of [['Escape', {}], ['a', {}], ['Tab', {}], ['Enter', { ctrlKey: true }], [' ', { altKey: true }]]) {
    assert.equal(press(winEl(0, 1), k, fields).defaultPrevented, false, k);
    assert.deepEqual(expanded(page), [false, false], k);
  }
  // Keys from inside a window's content aren't the window's.
  assert.equal(page.dispatch('keydown', { target: { closest: () => winEl(0, 0) }, key: 'Enter' }).defaultPrevented, false);
  assert.deepEqual(expanded(page), [false, false]);
});

test('expanded details survive re-renders, refreshes with reordered accounts and the Table view, and vanished windows are forgotten', async () => {
  const quotas = quotasOf(
    account('claude:a', [win('5-hour', 30, 9000), win('Weekly', 40, 302_400, WEEK)]),
    account('openai:b', [win('5-hour', 20, 9000), win('Weekly', 10, 302_400, WEEK)], { provider: 'openai', name: 'ChatGPT', plan: 'Plus' }),
  );
  const page = await loadDashboard({ quotas, now: NOW });
  const { element, winEl, click, run } = page;
  const html = () => element('content').innerHTML;
  click(winEl(0, 1)); // claude:a Weekly
  assert.deepEqual(expanded(page), [false, true, false, false]);

  run('render()');
  assert.deepEqual(expanded(page), [false, true, false, false]);

  // A refresh puts ChatGPT first and changes the numbers: the same account's window stays open, with the new reading.
  const [claude, chatgpt] = quotas.accounts;
  claude.windows[1].usedPct = 65;
  quotas.accounts = [chatgpt, claude];
  await element('refresh').onclick();
  assert.deepEqual(expanded(page), [false, false, false, true]);
  assert.equal(winEl(1, 1).getAttribute('aria-controls'), 'win-1-1-details');
  const details = detailsOf(html(), 'win-1-1-details');
  assert.equal(details.hidden, false);
  assert.ok(details.html.includes('<span class="k">Claude Max:</span> Weekly'), details.html);
  assert.ok(details.html.includes('<span class="k">Used:</span> 65%') && details.html.includes('<span class="k">Left:</span> 35%'), details.html);

  // The Table view is unchanged, and switching back keeps the window open.
  element('view').onclick();
  assert.ok(!html().includes('Details') && !html().includes('class="win"'), html());
  element('view').onclick();
  assert.deepEqual(expanded(page), [false, false, false, true]);

  // A window that disappears is forgotten, so it comes back collapsed.
  claude.windows.pop();
  await run('load(true)');
  assert.equal(run('openWindows.size'), 0);
  claude.windows.push(win('Weekly', 65, 302_400, WEEK));
  await run('load(true)');
  assert.deepEqual(expanded(page), [false, false, false, false]);
});

test('the hover tooltip shows only for a fine pointer, never on focus or touch, and follows a re-render to the window under the pointer', async () => {
  const page = await renderQuotas(quotasOf(account('claude:a', [win('5-hour', 30, 9000), win('Weekly', 40, 302_400, WEEK)])));
  const { document, element, media, listeners, winEl, hover, click, dispatch, run, tick } = page;
  const tip = element('tip');
  const shown = () => tip.style.display === 'block';
  assert.equal(listeners.focusin, undefined, 'focus no longer opens the tooltip');
  assert.equal(listeners.focusout, undefined);

  hover(0, 0);
  assert.ok(shown());
  assert.ok(tip.innerHTML.includes('<span class="k">Used:</span> 30%'), tip.innerHTML);
  dispatch('pointermove', { target: { closest: () => null }, pointerType: 'mouse' });
  assert.ok(!shown());

  // A re-render replaces the cards, and a resting pointer sends no pointermove. So the tooltip shows again,
  // with fresh numbers, for the window now under the pointer, and hides when there is none.
  hover(0, 0);
  run('render()');
  assert.ok(!shown(), 'nothing under the pointer');
  const asked = [];
  document.elementFromPoint = (x, y) => { asked.push([x, y]); return winEl(0, 0); };
  hover(0, 0);
  run('data.accounts[0].windows[0].usedPct = 35; render();');
  tick();
  assert.ok(shown(), 'the clock tick and a reload keep it');
  assert.ok(tip.innerHTML.includes('<span class="k">Used:</span> 35%'), tip.innerHTML);
  assert.deepEqual(asked, [[10, 10], [10, 10]]);
  dispatch('pointerout', { relatedTarget: winEl(0, 1) });
  assert.ok(shown(), 'moving within the page keeps it');
  dispatch('pointerout', { relatedTarget: null });
  assert.ok(!shown(), 'leaving the page hides it');
  run('render()');
  assert.ok(!shown(), 'and a re-render does not bring it back');
  run('tableView = true; render(); tableView = false; render();');
  assert.ok(!shown(), 'the Table view has no windows');
  document.elementFromPoint = () => null;

  hover(0, 0, 'touch');
  assert.ok(!shown(), 'touch');
  media.fine = false;
  hover(0, 0);
  assert.ok(!shown(), 'coarse pointer or no hover');
  media.fine = true;

  // An expanded window already shows the same rows inline, so it gets no tooltip.
  click(winEl(0, 1));
  hover(0, 1);
  assert.ok(!shown());
  hover(0, 0);
  assert.ok(shown());
  document.elementFromPoint = () => winEl(0, 1);
  run('render()');
  assert.ok(!shown(), 'nor after a re-render puts it under the pointer');
});

test('the 15-second clock tick leaves the cards alone while a window has focus, so a screen reader does not read it again', async () => {
  const page = await renderQuotas(quotasOf(account('claude:a', [win('5-hour', 30, 9000), win('Weekly', 40, 302_400, WEEK)])));
  const { document, element, winEl, run, tick } = page;
  const html = () => element('content').innerHTML;
  run('data.accounts[0].windows[0].usedPct = 50;');
  tick();
  assert.ok(html().includes('<span class="big">50%</span>'), 'without focus the tick redraws');

  const focused = winEl(0, 1);
  focused.focus();
  const before = html();
  run('data.accounts[0].windows[0].usedPct = 60;');
  tick();
  assert.equal(html(), before);
  assert.equal(document.activeElement, focused, 'focus did not move');
  assert.equal(document.title, '40% · Quotas', 'the tab title still updates');

  // A load or a toggle still redraws, and keeps focus on the same window.
  run('render()');
  assert.ok(html().includes('<span class="big">40%</span>'), html());
  assert.notEqual(document.activeElement, focused);
  assert.equal(document.activeElement.dataset.key, focused.dataset.key);
});

test('the meta line shows the running commit and warns in text when it is not current', async () => {
  const base = { commit: 'abc1234', startedAt: 1, diskCommit: 'abc1234', upstreamCommit: 'abc1234', upstreamCheckedAt: 1, upstreamError: false, restartNeeded: false, behindUpstream: false };
  const meta = async (version) => (await loadDashboard({ version })).element('meta').innerHTML;
  const link = (sha) => `<a href="https://github.com/omertekin2002/ai-quota-dashboard/commit/${sha}" target="_blank" rel="noopener noreferrer"><code>${sha}</code></a>`;

  const current = await meta(base);
  assert.ok(current.startsWith('Claude, ChatGPT &amp; Antigravity · updated '), current);
  assert.ok(current.endsWith(` · running ${link('abc1234')}`), current);
  assert.ok(!current.includes('⚠'));

  const restart = await meta({ ...base, diskCommit: 'def5678', upstreamCommit: 'def5678', restartNeeded: true, behindUpstream: true });
  assert.ok(restart.includes(`<span class="version-warn">⚠ Restart needed to run ${link('def5678')}</span>`), restart);
  // A restart would bring it up to main, so no second warning.
  assert.equal(restart.split('⚠').length - 1, 1);

  const behind = await meta({ ...base, upstreamCommit: '9876fed', behindUpstream: true });
  assert.ok(behind.includes(`<span class="version-warn">⚠ Running ${link('abc1234')}, main is at ${link('9876fed')}</span>`), behind);
  assert.ok(!behind.includes('Restart'));

  const both = await meta({ ...base, diskCommit: 'def5678', upstreamCommit: '9876fed', restartNeeded: true, behindUpstream: true });
  assert.ok(both.includes('⚠ Restart needed to run') && both.includes('main is at'), both);

  // Unknown version (no git, or an older server with no /api/version): nothing extra.
  for (const version of [{ ...base, commit: null, restartNeeded: false, behindUpstream: false }, null]) {
    const html = await meta(version);
    assert.ok(!html.includes('running') && !html.includes('⚠'), html);
  }
});

test('the version line escapes anything that is not a SHA and links only real SHAs', async () => {
  const { element } = await loadDashboard({ version: {
    commit: '<img src=x onerror=alert(1)>', diskCommit: '"><script>bad()</script>', upstreamCommit: 'abc1234',
    restartNeeded: true, behindUpstream: true,
  } });
  const html = element('meta').innerHTML;
  assert.ok(!html.includes('<img') && !html.includes('<script'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.equal(html.match(/<a /g).length, 1); // only the real SHA, abc1234, is a link
});

test('the Workspace panel shows the auto-update row in every state, with text warnings for failures and a stopped timer', async () => {
  const now = Date.now();
  const workspace = { generatedAt: now, supported: true, model: 'HP laptop', uptimeSec: 100, power: { acOnline: true, batteries: [] }, temperatures: [], memory: null,
    internet: { state: 'online', latencyMs: 5 }, services: [],
    autoUpdate: { state: 'ok', timerActive: true, lastRunAt: now - 60_000, lastExitStatus: 0, nextRunAt: now + 600_000 } };
  const { context, element, run } = await loadDashboard({ workspace });
  const row = (autoUpdate) => {
    context.autoUpdateFixture = autoUpdate;
    run('workspace.autoUpdate = autoUpdateFixture; renderWorkspace();');
    const html = element('workspace-content').innerHTML;
    return html.slice(html.indexOf('<p class="auto-update">'));
  };
  const clock = (ms) => run(`fmtClock(${ms})`);
  const base = workspace.autoUpdate;

  const ok = row(base);
  assert.ok(ok.includes(`Auto-update: last run ${clock(base.lastRunAt)} <span class="healthy">✓</span> · next ${clock(base.nextRunAt)}`), ok);
  assert.ok(!ok.includes('⚠') && !ok.includes('journalctl'));

  const failed = row({ ...base, state: 'failed', lastExitStatus: 1 });
  for (const text of ['⚠', 'failed', 'exit 1', '<code>journalctl --user -u ai-quota-dashboard-update</code>', `next ${clock(base.nextRunAt)}`]) assert.ok(failed.includes(text), text);
  assert.ok(failed.includes('class="warning"'));

  const stopped = row({ ...base, timerActive: false, nextRunAt: null });
  assert.ok(stopped.includes('⚠ timer stopped'), stopped);
  assert.ok(!stopped.includes('next '));

  assert.ok(row({ ...base, state: 'running' }).includes(`running now · last run ${clock(base.lastRunAt)}`));
  assert.ok(row({ ...base, state: 'never-run', lastRunAt: null, lastExitStatus: null }).includes('no completed run recorded'));
  const missing = row({ state: 'not-installed', timerActive: null, lastRunAt: null, lastExitStatus: null, nextRunAt: null });
  assert.ok(missing.includes('Auto-update: not installed') && !missing.includes('⚠') && !missing.includes('warning'), missing);
  const unknown = row({ state: 'unknown', timerActive: null, lastRunAt: null, lastExitStatus: null, nextRunAt: null });
  assert.ok(unknown.includes('Auto-update: status unavailable') && !unknown.includes('⚠'), unknown);
  // Anything unexpected from the server is escaped, never rendered as markup.
  const odd = row({ state: '<img src=x>', timerActive: true, lastExitStatus: '<b>', nextRunAt: null });
  assert.ok(!odd.includes('<img') && odd.includes('status unavailable'), odd);
  assert.ok(!row({ ...base, state: 'failed', lastExitStatus: '<img src=x>' }).includes('<img'));
  // A server from before this row existed shows no row at all.
  run('delete workspace.autoUpdate; renderWorkspace();');
  assert.ok(!element('workspace-content').innerHTML.includes('Auto-update'));
});

// A request that only settles when its signal aborts, like a server that accepted the connection and then stalled.
const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

test('every page request is bounded: quotas at least 60 s, version 10 s, workspace and pipeline unchanged', async () => {
  const requests = [];
  const { signals } = await loadDashboard({ respond: (url, init) => { requests.push([url.split('?')[0], init?.signal]); } });
  const bounds = requests.map(([url, signal]) => [url, signals.find((s) => s.controller.signal === signal)?.ms]);
  assert.deepEqual(Object.fromEntries(bounds), { '/api/version': 10_000, '/api/quotas': 60_000, '/api/workspace': 12_000, '/api/pipeline': 100_000 });
  assert.equal(bounds.length, 4);
});

test('the quota timeout grows by 30 s per account in the last reading, since the server reads accounts one at a time', async () => {
  const many = (n) => quotasOf(...Array.from({ length: n }, (_, i) => account(`claude:${i}`, [win('5-hour', 10, 9000)])));
  for (const [n, ms] of [[0, 60_000], [1, 60_000], [2, 75_000], [5, 165_000]]) {
    const { run, signals } = await loadDashboard({ quotas: many(n), now: NOW });
    assert.equal(run('quotaTimeoutMs()'), ms, `${n} accounts`);
    const before = signals.length;
    await run('load(true)');
    assert.ok(signals.slice(before).some((s) => s.ms === ms), `${n} accounts: ${signals.slice(before).map((s) => s.ms)}`);
  }
});

test('a hung quota request times out, keeps the last cards, stops claiming Live, and releases Refresh', async () => {
  const live = account('claude:a', [win('5-hour', 30, 9000)], { fetchedAt: NOW - 300_000 });
  const stale = account('openai:b', [win('5-hour', 50, 9000)], {
    provider: 'openai', name: 'ChatGPT', stale: true, fetchedAt: NOW - 3_600_000, error: 'Token expired. Run `codex` to sign in again.',
  });
  let mode = 'ok';
  let quotaRequests = 0;
  const page = await loadDashboard({
    quotas: quotasOf(live, stale), now: NOW,
    version: { commit: 'abc1234', diskCommit: 'abc1234', upstreamCommit: 'abc1234', restartNeeded: false, behindUpstream: false },
    respond: (url, init) => {
      if (!url.startsWith('/api/quotas')) return undefined;
      quotaRequests++;
      if (mode === 'hang') return hang(init);
      if (mode === 'http500') return { ok: false, status: 500, json: async () => ({ error: 'internal error' }) };
      return undefined;
    },
  });
  const { element, run, expire } = page;
  const cards = () => cardsOf(element('content').innerHTML);
  const staleBefore = cards()[1];
  assert.ok(cards()[0].includes('● Live'), cards()[0]);
  assert.ok(!element('meta').innerHTML.includes('refresh'), element('meta').innerHTML);
  assert.equal(quotaRequests, 1);

  mode = 'hang';
  const clicked = element('refresh').onclick();
  await settle();
  assert.equal(element('refresh').disabled, true);
  assert.equal(run('loading'), true);
  assert.equal(quotaRequests, 2);
  run('load(true)'); // ignored while the hung request is in flight
  assert.equal(quotaRequests, 2);

  expire(75_000); // two accounts: 15 s + 2 × 30 s
  await clicked;
  assert.equal(element('refresh').disabled, false);
  assert.equal(run('loading'), false);
  const banner = element('banner').innerHTML;
  assert.ok(banner.includes("The quota server didn't answer within 75 s. Showing the last reading."), banner);
  for (const raw of ['TimeoutError', 'AbortError', 'aborted', 'timed out']) assert.ok(!banner.includes(raw), `${raw} in ${banner}`);
  const [liveCard, staleCard] = cards();
  assert.ok(liveCard.includes('<span class="big">70%</span>'), liveCard);
  assert.ok(!element('content').innerHTML.includes('● Live'), liveCard);
  assert.ok(liveCard.includes('<span class="fresh stale" title="Couldn&#39;t refresh. Read from Claude Code">◷ 5m ago</span>'), liveCard);
  assert.equal(staleCard, staleBefore);
  assert.ok(element('meta').innerHTML.includes(`<span class="version-warn">⚠ Couldn't refresh</span>`), element('meta').innerHTML);
  assert.ok(element('meta').innerHTML.includes('running <a '), element('meta').innerHTML);
  run('tableView = true; render();');
  assert.ok(tableRowsOf(element('content').innerHTML)[0].includes(' (reading from 5m ago)</td>'), element('content').innerHTML);
  run('tableView = false; render();');

  // Any other failure is still reported with its reason, and still isn't Live.
  mode = 'http500';
  await run('load(true)');
  assert.equal(quotaRequests, 3);
  assert.ok(element('banner').innerHTML.includes("Can't reach the quota server (HTTP 500)"), element('banner').innerHTML);
  assert.ok(!element('content').innerHTML.includes('● Live'));

  // The next successful load restores Live and clears the warnings.
  mode = 'ok';
  await run('load(true)');
  assert.equal(quotaRequests, 4);
  assert.equal(element('banner').innerHTML, '');
  assert.ok(cards()[0].includes('● Live'), cards()[0]);
  assert.equal(cards()[1], staleBefore);
  assert.ok(!element('meta').innerHTML.includes('refresh'), element('meta').innerHTML);
  assertClean(element('content').innerHTML);
});

test('each quota timeout in a row doubles the next budget, up to 10 min, and a success resets it', async () => {
  // The server's cache lasts 90 s from the start of a collection, so a collection slower than the page's timeout
  // would be aborted on every poll if the timeout never grew.
  let hung = true;
  let quotaSignal = null;
  const page = await loadDashboard({ now: NOW, respond: (url, init) => {
    if (!url.startsWith('/api/quotas')) return undefined;
    quotaSignal = init.signal;
    return hung ? hang(init) : undefined;
  } });
  const quotaBudget = () => page.signals.find((s) => s.controller.signal === quotaSignal).ms;
  const budgets = [];
  for (let i = 0; i < 6; i++) {
    if (i) page.run('load(true)');
    await settle();
    budgets.push(quotaBudget());
    page.expire(quotaBudget());
    await settle();
    assert.ok(page.element('banner').innerHTML.includes(`didn't answer within ${quotaBudget() / 1000} s`), page.element('banner').innerHTML);
  }
  assert.deepEqual(budgets, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  hung = false;
  await page.run('load(true)');
  assert.equal(quotaBudget(), 600_000);
  assert.equal(page.element('banner').innerHTML, '');
  assert.equal(page.run('quotaTimeoutMs()'), 60_000);
  // After a success, the next timeout starts doubling from the base again.
  hung = true;
  page.run('load(true)');
  await settle();
  page.expire(60_000);
  await settle();
  assert.equal(page.run('quotaTimeoutMs()'), 120_000);
});

test('a first quota load that times out shows the banner and leaves Refresh usable', async () => {
  let hung = true;
  const page = await loadDashboard({ now: NOW, respond: (url, init) => (url.startsWith('/api/quotas') && hung ? hang(init) : undefined) });
  assert.equal(page.element('refresh').disabled, true);
  page.expire(60_000);
  await settle();
  assert.equal(page.element('refresh').disabled, false);
  const banner = page.element('banner').innerHTML;
  assert.ok(banner.includes("The quota server didn't answer within 60 s. Is <code>node server.mjs</code> running?"), banner);
  hung = false;
  await page.element('refresh').onclick();
  assert.equal(page.element('banner').innerHTML, '');
});

test('a hung version request holds quotas only until its own 10 s timeout, and the last version stays', async () => {
  let hung = false;
  const quotas = quotasOf(account('claude:a', [win('5-hour', 30, 9000)]));
  const page = await loadDashboard({
    quotas, now: NOW,
    version: { commit: 'abc1234', diskCommit: 'abc1234', upstreamCommit: 'abc1234', restartNeeded: false, behindUpstream: false },
    respond: (url, init) => (url.startsWith('/api/version') && hung ? hang(init) : undefined),
  });
  assert.ok(page.element('meta').innerHTML.includes('<code>abc1234</code>'));
  hung = true;
  quotas.accounts[0].windows[0].usedPct = 80;
  const reload = page.run('load(true)');
  await settle();
  assert.equal(page.run('loading'), true);
  page.expire(10_000);
  await reload;
  assert.equal(page.run('loading'), false);
  assert.ok(page.element('content').innerHTML.includes('<span class="big">20%</span>'), page.element('content').innerHTML);
  assert.ok(page.element('content').innerHTML.includes('● Live'));
  assert.ok(page.element('meta').innerHTML.includes('<code>abc1234</code>'), page.element('meta').innerHTML);
  assert.equal(page.element('banner').innerHTML, '');
});

test('without AbortSignal.timeout (Safari before 16) every request still gets its timeout, and a hung quota load releases Refresh', async () => {
  let hung = false;
  const page = await loadDashboard({
    abortSignalTimeout: false, quotas: quotasOf(account('claude:a', [win('5-hour', 30, 9000)])), now: NOW,
    respond: (url, init) => (url.startsWith('/api/quotas') && hung ? hang(init) : undefined),
  });
  const { element, run, timers } = page;
  assert.ok(element('content').innerHTML.includes('<span class="big">70%</span>'), element('content').innerHTML);
  assert.equal(run('workspaceError || pipelineError'), false);
  assert.deepEqual(timers.map((t) => t.ms), [10_000, 60_000, 12_000, 100_000]); // version, quotas, workspace, pipeline

  hung = true;
  const clicked = element('refresh').onclick();
  await settle();
  assert.equal(run('loading'), true);
  assert.equal(element('refresh').disabled, true);
  timers.filter((t) => t.ms === 60_000).at(-1).fn();
  await clicked;
  assert.equal(run('loading'), false);
  assert.equal(element('refresh').disabled, false);
  assert.ok(element('banner').innerHTML.includes("The quota server didn't answer within 60 s. Showing the last reading."), element('banner').innerHTML);
});

test('a live window past its reset reloads after 20 s, but not again while loads fail: the 2-minute poll retries then', async () => {
  let fail = false;
  let quotaRequests = 0;
  const page = await loadDashboard({
    quotas: quotasOf(account('claude:a', [win('5-hour', 30, -60)])), now: NOW,
    respond: (url) => {
      if (!url.startsWith('/api/quotas')) return undefined;
      quotaRequests++;
      return fail ? { ok: false, status: 500, json: async () => ({ error: 'internal error' }) } : undefined;
    },
  });
  const { element, run, timers, tick } = page;
  const reloads = () => timers.filter((t) => t.ms === 20_000);
  assert.equal(reloads().length, 1);

  fail = true;
  reloads()[0].fn();
  await settle();
  assert.equal(quotaRequests, 2);
  assert.ok(element('banner').innerHTML.includes("Can't reach the quota server (HTTP 500)"), element('banner').innerHTML);
  run('render()');
  tick();
  assert.equal(reloads().length, 1, 'no forced reload while the last load failed');

  fail = false;
  await run('load()');
  assert.equal(quotaRequests, 3);
  assert.equal(reloads().length, 2, 'a successful load schedules it again');
});

// ---------- At a glance ----------
// Healthy readings for every source; each scenario below changes one thing.
const healthyWorkspace = () => ({
  generatedAt: NOW, supported: true, model: 'HP laptop', uptimeSec: 10_000,
  power: { acOnline: true, batteries: [{ percent: 100, status: 'Full' }] }, temperatures: [{ name: 'CPU', celsius: 50, criticalCelsius: 100 }],
  memory: { usedPct: 50, usedBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 }, internet: { state: 'online', latencyMs: 40 },
  services: [{ name: 'CLIProxyAPI', unit: 'cli.service', state: 'running', automaticRestarts: 0 }, { name: 'T3 Code', unit: 't3code.service', state: 'running', automaticRestarts: 0 }],
  diagnostics: { memoryLevel: 'healthy', pressure: { cpu: null, memory: null, io: null }, topProcesses: [],
    disks: [{ name: 'T7 drive', path: '/mnt/nas', mounted: true, readOnly: false, usedPct: 40, freeBytes: 600 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }],
    backup: { state: 'success', lastSuccessAt: NOW - 3600_000, scheduleActive: true, nextRunAt: NOW + 3600_000 },
    tailscale: { state: 'running', connections: [] },
    healthChecks: [{ service: 'cli.service', id: 'cli-health', label: 'Backend health', state: 'healthy', detail: 'OK', checkedAt: NOW, latencyMs: 5 }] },
  history: { events: [], samples: [], persisted: true },
  autoUpdate: { state: 'ok', timerActive: true, lastRunAt: NOW - 60_000, lastExitStatus: 0, nextRunAt: NOW + 600_000 },
});
const pipelineOf = (attention = [], extra = {}) => ({ available: true, fetchedAt: NOW - 60_000, refreshMs: 300_000, error: null,
  overview: { version: 1, attention, repos: [], github: { available: true, errors: [], truncated: [] } }, ...extra });
const healthyQuotas = () => quotasOf(
  account('claude:a', [win('5-hour', 20, 9000), win('Weekly', 40, 3 * 86400, WEEK)]),
  account('openai:b', [win('5-hour', 50, 7200)], { provider: 'openai', name: 'ChatGPT', plan: 'Plus', email: 'b@example.com' }),
);
// A tile's visible text, with tags dropped and entities decoded.
const tileText = (page, id) => unescapeHtml(page.element(`glance-${id}`).innerHTML.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tiles = (page) => Object.fromEntries(['capacity', 'attention', 'workspace'].map((id) => [id, tileText(page, id)]));
const glancePage = (options = {}) => loadDashboard({ quotas: healthyQuotas(), workspace: healthyWorkspace(), pipeline: pipelineOf(), now: NOW, ...options });
const failWith = (prefix) => (url) => (url.startsWith(prefix) ? { ok: false, status: 500, json: async () => ({ error: 'internal error' }) } : undefined);

test('an At a glance strip sits under the top bar, above the Workspace computer panel, and each tile links to its panel', () => {
  const strip = html.match(/<section class="overview" id="overview" aria-label="At a glance">([\s\S]*?)<\/section>/);
  assert.ok(strip, 'the strip exists');
  assert.ok(html.indexOf('<div class="top">') < strip.index);
  assert.ok(strip.index < html.indexOf('aria-labelledby="workspace-title"'));
  const links = [...strip[1].matchAll(/<h2><a href="#([\w-]+)">([^<]+)<\/a><\/h2><div id="glance-(\w+)">/g)].map((m) => m.slice(1));
  assert.deepEqual(links, [['content', 'Capacity', 'capacity'], ['pipeline', 'Needs you', 'attention'], ['workspace', 'Workspace', 'workspace']]);
  for (const [id] of links) assert.match(html, new RegExp(`<(div|section)[^>]* id="${id}"`), id);
});

test('At a glance, healthy: each account’s tightest window, nothing needs you, and the workspace is all OK', async () => {
  const page = await glancePage();
  const t = tiles(page);
  assert.equal(t.capacity, 'Claude Max · a@example.com Weekly 60% left · resets in 3d ChatGPT Plus · b@example.com 5-hour 50% left · resets in 2h');
  assert.equal(t.attention, '✓ Nothing needs you');
  assert.equal(t.workspace, '✓ All OK');
  for (const id of ['capacity', 'attention', 'workspace']) assertClean(page.element(`glance-${id}`).innerHTML.replace(/<\/?(p|ul|li|strong)( class="[^"]*")?>/g, ''));
});

test('At a glance, quota-constrained: the binding window with its level and reset, reading ages for stale accounts, and — for unknown usage', async () => {
  const page = await glancePage({ quotas: quotasOf(
    account('claude:a', [win('5-hour', 50, 9000), win('Weekly', 92, 2 * 86400 + 3 * 3600, WEEK)]),
    account('claude:low', [win('5-hour', 75, 3600)], { email: 'low@example.com' }),
    account('claude:stale', [win('5-hour', 20, 9000)], { email: 'stale@example.com', stale: true, fetchedAt: NOW - 3 * 3600_000, error: 'Token expired.' }),
    account('openai:unknown', [win('5-hour', null, 3600), win('Weekly', null, 86400, WEEK)], { provider: 'openai', name: 'ChatGPT', email: 'u@example.com' }),
    account('openai:err', [], { provider: 'openai', name: 'ChatGPT', email: 'e@example.com', error: 'Not signed in' }),
    account('openai:reset', [win('5-hour', 70, -60)], { provider: 'openai', name: 'ChatGPT', email: 'r@example.com' }),
  ) });
  const rows = page.element('glance-capacity').innerHTML.split('<li class="glance-row">').slice(1).map((r) => unescapeHtml(r.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  assert.deepEqual(rows, [
    'Claude Max · a@example.com Weekly 8% left · resets in 2d 3h ⛔ Nearly out',
    'Claude Max · low@example.com 5-hour 25% left · resets in 1h ⚠ Low',
    'Claude Max · stale@example.com 5-hour 80% left · resets in 2h 30m ◷ 3h ago',
    'ChatGPT Max · u@example.com — Usage unknown',
    "ChatGPT Max · e@example.com — Couldn't read usage",
    'ChatGPT Max · r@example.com 5-hour 100% left · Estimated. Refreshing…',
  ]);
  assert.ok(page.element('glance-capacity').innerHTML.includes('<span class="critical">⛔ Nearly out</span>'));
  assert.ok(!rows[3].includes('100%'));
  // Nothing is summed or compared across accounts.
  assert.ok(!/total|combined/i.test(tileText(page, 'capacity')));
});

test('At a glance, owner-blocked: the attention total, its count per kind, and 🔥 when one is urgent', async () => {
  const item = (kind, number, extra = {}) => ({ kind, repo: 'o/alpha', number, url: `https://github.com/o/alpha/issues/${number}`, title: `item ${number}`, action: 'Act', ...extra });
  const page = await glancePage({ pipeline: pipelineOf([item('needs-human', 8), item('needs-human', 9), item('decision', 14, { urgent: true }), item('umbrella', 20)]) });
  assert.equal(tileText(page, 'attention'), '🔥 4 items need you 2 blocked · 1 decision · 1 umbrella to merge · 🔥 1 urgent');
  assert.ok(page.element('glance-attention').innerHTML.includes('<p class="glance-lead critical">'));
  // Kinds are build-workflow's own, in its order; an unknown kind is only counted.
  page.run(`pipeline.overview.attention = [{ kind: 'review', number: 1 }, { kind: 'review', number: 2 }, { kind: 'something-new', number: 3 }]; renderPipeline();`);
  assert.equal(tileText(page, 'attention'), '3 items need you 2 PRs to review · 1 other');
  page.run(`pipeline.overview.attention = [{ kind: 'decision', number: 1 }]; pipeline.overview.github = { available: false, errors: ['down'] }; renderPipeline();`);
  assert.equal(tileText(page, 'attention'), '1 item needs you 1 decision ⚠ GitHub unavailable: only local items are current');
  assert.ok(page.element('glance-attention').innerHTML.includes('<p class="glance-lead warning">'));
});

test('At a glance, partially unavailable: each source failing on its own changes only its own tile', async () => {
  const healthy = tiles(await glancePage());
  const cases = {
    '/api/quotas': { capacity: "⚠ Couldn't refresh" },
    '/api/workspace': { workspace: 'Unavailable' },
    '/api/pipeline': { attention: 'Pipeline unavailable' },
  };
  for (const [url, changed] of Object.entries(cases)) {
    const page = await glancePage({ respond: failWith(url) });
    assert.deepEqual(tiles(page), { ...healthy, ...changed }, url);
  }

  // A source that fails after a good reading keeps it, with its age.
  let failing = null;
  const page = await glancePage({ respond: (url, init) => (failing && url.startsWith(failing) ? failWith(failing)(url, init) : undefined) });
  failing = '/api/pipeline';
  await page.run('loadPipeline()');
  assert.equal(tileText(page, 'attention'), "✓ Nothing needs you ⚠ Couldn't refresh · ◷ 1m ago");
  failing = '/api/workspace';
  await page.run('loadWorkspace()');
  assert.equal(tileText(page, 'workspace'), "✓ All OK ⚠ Couldn't refresh · ◷ just now");
  failing = '/api/quotas';
  await page.run('load()');
  const capacity = tileText(page, 'capacity');
  assert.ok(capacity.startsWith('Claude Max · a@example.com Weekly 60% left · resets in 3d ◷ just now'), capacity);
  assert.ok(capacity.endsWith("⚠ Couldn't refresh"), capacity);
  assert.equal(tileText(page, 'attention'), "✓ Nothing needs you ⚠ Couldn't refresh · ◷ 1m ago");

  // The pipeline's own last update failed, or the workspace reading is over 90 s old: both say how old.
  const stale = await glancePage({ pipeline: pipelineOf([], { error: 'agentctl overview failed or timed out', fetchedAt: NOW - 900_000 }),
    workspace: { ...healthyWorkspace(), generatedAt: NOW - 120_000 } });
  assert.equal(tileText(stale, 'attention'), "✓ Nothing needs you ⚠ Couldn't refresh · ◷ 15m ago");
  assert.equal(tileText(stale, 'workspace'), '✓ All OK ◷ 2m ago');
  assert.equal(stale.element('workspace-error').hidden, false, 'the panel calls the same reading old');
  const linux = await glancePage({ workspace: { supported: false } });
  assert.equal(tileText(linux, 'workspace'), 'Monitoring is available on Linux');
});

test('At a glance: workspace conditions come from the same rules as the panels’ levels', async () => {
  const workspace = healthyWorkspace();
  workspace.diagnostics.healthChecks[0] = { ...workspace.diagnostics.healthChecks[0], state: 'unhealthy', detail: 'HTTP 503' };
  workspace.diagnostics.backup = { ...workspace.diagnostics.backup, state: 'failed' };
  workspace.diagnostics.memoryLevel = 'critical';
  workspace.autoUpdate = { ...workspace.autoUpdate, state: 'failed', lastExitStatus: 1 };
  const page = await glancePage({ workspace });
  const conditions = JSON.parse(page.run('JSON.stringify(workspaceConditions(workspace))'));
  assert.deepEqual(conditions, [
    { level: 'critical', text: 'CLIProxyAPI check failed' },
    { level: 'critical', text: 'Memory under pressure' },
    { level: 'critical', text: 'T7 backup failed' },
    { level: 'warning', text: 'Auto-update failed' },
  ]);
  // The panels show each of them at the same level.
  const panel = page.element('workspace-content').innerHTML, diagnostics = page.element('workspace-diagnostics').innerHTML;
  assert.ok(panel.includes('<div class="service-state critical"><span class="health-dot" aria-hidden="true"></span>Running · Check failed'), panel);
  assert.ok(panel.includes('<div class="metric-value critical">50%'), 'memory metric');
  assert.ok(diagnostics.includes('<div class="diagnostic-status critical">Memory under pressure'));
  assert.ok(diagnostics.includes('<span class="diagnostic-status critical">Last run failed'));
  assert.ok(panel.includes('<span class="warning">⚠ last run'), 'auto-update');
  assert.equal(tileText(page, 'workspace'), '⛔ 3 critical · ⚠ 1 warning ⛔ CLIProxyAPI check failed · ⛔ Memory under pressure · +2 more');

  // Every other rule, one at a time: the tile's level is the level the panel colors that reading with.
  const cases = [
    ['workspace.services[1].state = "failed"', 'critical', 'T3 Code failed', 'service-state critical'],
    ['workspace.services[1].state = "not-found"', 'warning', 'T3 Code not installed', 'service-state warning'],
    ['workspace.diagnostics.healthChecks.push({ service: "t3code.service", id: "t3", label: "Page", state: "unknown", detail: "Not checked yet", checkedAt: Date.now() })', 'warning', 'T3 Code Page: Not checked yet', 'health-check warning'],
    ['workspace.diagnostics.memoryLevel = "warning"', 'warning', 'Memory needs attention', 'metric-value warning'],
    ['workspace.internet.state = "offline"', 'critical', 'Internet offline', 'metric-value critical'],
    ['workspace.internet.state = "portal"', 'warning', 'Network sign-in needed', 'metric-value warning'],
    ['workspace.power = { acOnline: false, batteries: [{ percent: 25, status: "Discharging" }] }', 'warning', 'Battery 25% on battery power', 'metric-value warning'],
    ['workspace.power = { acOnline: false, batteries: [{ percent: 8, status: "Discharging" }] }', 'critical', 'Battery 8% on battery power', 'metric-value critical'],
    ['workspace.temperatures[0].celsius = 95', 'warning', 'CPU at 95°C', 'metric-value warning'],
    ['workspace.diagnostics.disks[0].mounted = false', 'critical', 'T7 drive not mounted', 'diagnostic-status critical'],
    ['workspace.diagnostics.disks[0].usedPct = 92', 'warning', 'T7 drive 92% full', 'diagnostic-status warning'],
    ['workspace.diagnostics.backup.lastSuccessAt = Date.now() - 40 * 3600_000', 'warning', 'No successful T7 backup in 36h', 'diagnostic-status warning'],
    ['workspace.diagnostics.backup.scheduleActive = false', 'warning', 'T7 backup schedule inactive', 'diagnostic-status warning'],
    ['workspace.autoUpdate.timerActive = false', 'warning', 'Auto-update timer stopped', 'class="warning">⚠ timer stopped'],
  ];
  for (const [change, level, text, panelClass] of cases) {
    const p = await glancePage();
    assert.equal(p.run('JSON.stringify(workspaceConditions(workspace))'), '[]');
    p.run(`${change}; renderWorkspace();`);
    assert.deepEqual(JSON.parse(p.run('JSON.stringify(workspaceConditions(workspace))')), [{ level, text }], change);
    assert.ok((p.element('workspace-content').innerHTML + p.element('workspace-diagnostics').innerHTML).includes(panelClass), `${change}: panel shows ${panelClass}`);
    assert.ok(tileText(p, 'workspace').includes(`${level === 'critical' ? '⛔' : '⚠'} ${text}`), tileText(p, 'workspace'));
  }
});

test('At a glance escapes account, window, service and check strings', async () => {
  const evil = '<script>alert(1)</script>';
  const workspace = healthyWorkspace();
  workspace.services[0].name = evil;
  workspace.diagnostics.healthChecks[0].state = 'unhealthy';
  workspace.diagnostics.healthChecks.push({ service: 't3code.service', id: 'x', label: '<img src=x onerror=alert(1)>', state: 'unknown', detail: evil, checkedAt: NOW });
  workspace.diagnostics.disks[0] = { ...workspace.diagnostics.disks[0], name: evil, mounted: false };
  const page = await glancePage({
    workspace,
    quotas: quotasOf(account('claude:evil', [win(evil, 95, 3600)], { name: evil, plan: '<b>x</b>', email: '<img src=y>' }), account('claude:stale', [], { name: evil, error: evil })),
  });
  for (const id of ['capacity', 'attention', 'workspace']) {
    const out = page.element(`glance-${id}`).innerHTML;
    assert.ok(!/<(script|img|b)[\s>]/.test(out), out);
  }
  assert.ok(page.element('glance-capacity').innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(page.element('glance-workspace').innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt; check failed'));
  assert.ok(tileText(page, 'workspace').startsWith('⛔ 2 critical · ⚠ 1 warning'), tileText(page, 'workspace'));
});

test('At a glance adds no requests: load, every timer and Refresh fetch the same URLs as before', async () => {
  const urls = [];
  const page = await glancePage({ respond: (url) => { urls.push(url); } });
  const fire = async (ms) => { for (const i of page.intervals.filter((x) => x.ms === ms)) i.fn(); await settle(); };
  assert.deepEqual(page.intervals.map((i) => i.ms).sort((a, b) => a - b), [15_000, 30_000, 60_000, 120_000]);
  assert.deepEqual(urls.splice(0), ['/api/version', '/api/quotas', '/api/workspace', '/api/pipeline'], 'on load');
  await fire(15_000);
  assert.deepEqual(urls.splice(0), [], 'the 15-second clock tick only re-renders');
  await fire(30_000);
  assert.deepEqual(urls.splice(0), ['/api/workspace'], '30-second timer');
  await fire(60_000);
  assert.deepEqual(urls.splice(0), ['/api/pipeline'], '1-minute timer');
  await fire(120_000);
  assert.deepEqual(urls.splice(0), ['/api/version', '/api/quotas'], '2-minute timer');
  await page.element('refresh').onclick();
  assert.deepEqual(urls.splice(0), ['/api/version', '/api/quotas?force', '/api/workspace?force', '/api/pipeline?force'], 'Refresh');
  assert.equal(page.timers.length, 0, 'no new timers either');
  assert.ok(!/fetch\(/.test(html.slice(html.indexOf('// ---------- At a glance'), html.indexOf('async function refreshAll'))), 'the tile code fetches nothing');
});
