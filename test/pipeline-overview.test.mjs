import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPipelineOverview } from '../pipeline-overview.mjs';

const reading = (n) => JSON.stringify({ version: 1, generatedAt: `2026-10-26T12:0${n}:00Z`, attention: [], repos: [{ slug: `o/r${n}` }] });

function fake(results) {
  const calls = [];
  let t = 1_000_000;
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const r = results.shift();
    return typeof r === 'function' ? r() : r;
  };
  return { calls, run, now: () => t, advance: (ms) => { t += ms; } };
}

test('reads agentctl overview once, then answers from the cache until the refresh interval passes', async () => {
  const f = fake([reading(1), reading(2)]);
  const get = createPipelineOverview({ run: f.run, now: f.now, agentctl: '/bin/agentctl', refreshMs: 300_000, forceMinMs: 60_000 });
  const first = await get();
  assert.equal(first.available, true);
  assert.equal(first.overview.repos[0].slug, 'o/r1');
  assert.equal(first.fetchedAt, 1_000_000);
  assert.equal(first.nextRefreshAt, 1_300_000);
  assert.deepEqual(f.calls[0].args, ['overview', '--json']);
  assert.equal(f.calls[0].file, '/bin/agentctl');
  assert.ok(f.calls[0].opts.timeout >= 60_000 && f.calls[0].opts.maxBuffer >= 1024 * 1024);
  f.advance(299_000);
  assert.equal((await get()).overview.repos[0].slug, 'o/r1');
  assert.equal(f.calls.length, 1);
  f.advance(1000);
  // Due: the refresh starts in the background and the cached reading is answered right away.
  const due = await get();
  assert.equal(due.overview.repos[0].slug, 'o/r1');
  assert.equal(due.refreshing, true);
  await new Promise(setImmediate);
  assert.equal((await get()).overview.repos[0].slug, 'o/r2');
  assert.equal(f.calls.length, 2);
});

test('manual refresh waits for fresh data but reads GitHub at most once a minute', async () => {
  const f = fake([reading(1), reading(2), reading(3)]);
  const get = createPipelineOverview({ run: f.run, now: f.now, refreshMs: 300_000, forceMinMs: 60_000 });
  await get();
  f.advance(30_000);
  assert.equal((await get(true)).overview.repos[0].slug, 'o/r1');
  assert.equal(f.calls.length, 1);
  f.advance(30_000);
  assert.equal((await get(true)).overview.repos[0].slug, 'o/r2');
  assert.equal(f.calls.length, 2);
});

test('concurrent readers share one agentctl run', async () => {
  let release;
  const f = fake([() => new Promise((r) => { release = () => r(reading(1)); })]);
  const get = createPipelineOverview({ run: f.run, now: f.now });
  const both = Promise.all([get(), get(), get(true)]);
  await new Promise(setImmediate);
  release();
  const results = await both;
  assert.equal(f.calls.length, 1);
  assert.ok(results.every((r) => r.overview.repos[0].slug === 'o/r1'));
});

test('a failed or unreadable refresh keeps the last reading and says why; no reading at all is unavailable', async () => {
  const f = fake([null, reading(1), 'not JSON', JSON.stringify({ version: 2, repos: [], attention: [] })]);
  const get = createPipelineOverview({ run: f.run, now: f.now, refreshMs: 1000, forceMinMs: 1000 });
  const none = await get();
  assert.equal(none.available, false);
  assert.equal(none.overview, null);
  assert.equal(none.error, 'agentctl overview failed or timed out');
  f.advance(1000);
  assert.equal((await get(true)).error, null);
  f.advance(1000);
  const broken = await get(true);
  assert.equal(broken.available, true);
  assert.equal(broken.overview.repos[0].slug, 'o/r1');
  assert.equal(broken.fetchedAt, 1_001_000);
  assert.equal(broken.error, 'agentctl overview returned an unreadable result');
  f.advance(1000);
  assert.equal((await get(true)).error, 'agentctl overview returned an unreadable result'); // unknown version
});

// ---------------------------------------------------------------- rendering

async function page(pipelineResponse) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, style: {}, setAttribute() {} });
    return elements.get(id);
  };
  let response = pipelineResponse;
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {}, visibilityState: 'visible' },
    fetch: async (url) => {
      if (url.startsWith('/api/pipeline')) {
        if (response instanceof Error) throw response;
        return { ok: true, json: async () => response };
      }
      return { ok: true, json: async () => url.startsWith('/api/workspace') ? { generatedAt: Date.now(), supported: false } : { generatedAt: Date.now(), accounts: [] } };
    },
    AbortSignal, setInterval() {}, setTimeout() {},
  });
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(context);
  await new Promise(setImmediate);
  return { content: () => element('pipeline-content').innerHTML, meta: () => element('pipeline-meta').textContent, context, set: (r) => { response = r; } };
}

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const repo = {
  slug: 'o/alpha', url: 'https://github.com/o/alpha', defaultBranch: 'main', available: true, paused: false,
  vision: { number: 1, title: 'Ultimate form', url: 'https://github.com/o/alpha/issues/1' }, localSync: { status: 'in-sync', detail: 'local main matches origin', at: iso(5) },
  hold: 'One job per repo: queued work waits for implement job job-alpha-9',
  umbrella: { number: 20, title: '🤖 Agent improvements (2 stacked)', url: 'https://github.com/o/alpha/pull/20', isDraft: false, createdAt: iso(600) },
  lastUmbrella: null,
  stackedPrs: [{ number: 17, title: 'feat: stacked one', url: 'https://github.com/o/alpha/pull/17', mergedAt: iso(300), issue: 6 }],
  openPrs: [
    { number: 20, title: '🤖 Agent improvements (2 stacked)', url: 'https://github.com/o/alpha/pull/20', base: 'main', head: 'agent/improvements', isDraft: false, createdAt: iso(600), updatedAt: iso(5), author: 'o', reviewDecision: null, kind: 'umbrella' },
    { number: 21, title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', base: 'agent/improvements', head: 'agent/imp-9', isDraft: true, createdAt: iso(30), updatedAt: iso(5), author: 'o', reviewDecision: null, kind: 'improvement', issue: 9 },
  ],
  openPrCount: 2,
  issues: {
    working: [{ number: 9, title: 'implement the thing', url: 'https://github.com/o/alpha/issues/9', labels: [], createdAt: iso(90), state: 'working', job: { id: 'job-alpha-9', mode: 'implement', status: 'running', createdAt: iso(40), heartbeatAt: iso(2), stale: false }, pr: { number: 21, url: 'https://github.com/o/alpha/pull/21' } }],
    queued: [{ number: 11, title: 'next improvement', url: 'https://github.com/o/alpha/issues/11', labels: [], createdAt: iso(60), state: 'queued', queue: 'implement' }],
    blocked: [{ number: 8, title: 'needs a secret', url: 'https://github.com/o/alpha/issues/8', labels: [], createdAt: iso(100), state: 'blocked', waitingOn: [14] }],
    decision: [], review: [], stacked: [{ number: 6, title: 's', url: 'https://github.com/o/alpha/issues/6', labels: [], createdAt: iso(400), state: 'stacked' }],
    other: [{ number: 13, title: 'bug', url: 'https://github.com/o/alpha/issues/13', labels: [], createdAt: iso(400), state: 'other' }],
  },
  openIssueCount: 6, issuesTruncated: false,
  resolved: { issues: [{ number: 5, title: 'decided thing', url: 'https://github.com/o/alpha/issues/5', closedAt: iso(120), reason: 'COMPLETED', labels: ['agent:decision'] }],
    prs: [{ number: 17, title: 'feat: stacked one', url: 'https://github.com/o/alpha/pull/17', mergedAt: iso(300), base: 'agent/improvements', head: 'agent/imp-6', intoStack: true }] },
  jobs: { active: [{ id: 'job-alpha-9', mode: 'implement', status: 'running', issue: 9, createdAt: iso(40), heartbeatAt: iso(2), stale: false }],
    recent: [{ id: 'job-alpha-plan', mode: 'plan', status: 'done', createdAt: iso(200), finishedAt: iso(180), stale: false, summary: 'filed #11' }], recentCount: 1 },
  attention: [
    { kind: 'needs-human', repo: 'o/alpha', number: 8, url: 'https://github.com/o/alpha/issues/8', title: 'needs a secret', action: 'Answer decision #14: that unblocks it', waitingOn: [14] },
    { kind: 'decision', repo: 'o/alpha', number: 14, url: 'https://github.com/o/alpha/issues/14', title: 'Keep it?', urgent: true, options: ['Yes', 'No'], recommendation: 'B', action: 'Answer it: comment on the issue' },
    { kind: 'umbrella', repo: 'o/alpha', number: 20, url: 'https://github.com/o/alpha/pull/20', title: '1 stacked improvement(s)', stacked: 1, action: 'Review and merge umbrella PR #20 to land them' },
  ],
  pendingAnswers: [{ number: 5, question: 'Keep it?', answer: 'A: yes', at: iso(120) }],
};
const offline = { slug: 'o/beta', url: 'https://github.com/o/beta', defaultBranch: 'main', available: false, error: 'GitHub unavailable', paused: false, vision: null, localSync: null, hold: null,
  umbrella: null, lastUmbrella: null, stackedPrs: [], openPrs: [], openPrCount: 0, issues: { working: [], queued: [], blocked: [], decision: [], review: [], stacked: [], other: [] },
  openIssueCount: 0, issuesTruncated: false, resolved: { issues: [], prs: [] }, jobs: { active: [], recent: [], recentCount: 0 }, attention: [], pendingAnswers: [] };
const overview = { version: 1, generatedAt: iso(3), owner: 'o', stackBranch: 'agent/improvements', windowDays: 7, paused: false, configured: true, reposCachedAt: iso(60),
  github: { available: true, errors: [], truncated: [] }, attention: repo.attention, outOfScope: { attention: 6 }, repos: [repo, offline] };

test('renders the cross-repo attention list, each repo, and links to GitHub only', async () => {
  const p = await page({ available: true, fetchedAt: now - 180_000, refreshMs: 300_000, refreshing: false, error: null, overview });
  const html = p.content();
  for (const label of ['Needs your attention (3)', 'Blocked until you act (1)', 'Decisions to answer (1)', 'Umbrella PRs ready to review and merge (1)',
    'Answer decision #14: that unblocks it', '🔥 Decide', 'A: Yes · B: No · Agent suggests: B', 'Review and merge umbrella PR #20 to land them',
    'The digest also lists 6 items in repos outside the pipeline’s scope', 'Agents are acting on answers you gave: alpha (#5)',
    'Open pull requests (2)', 'Stacked into the umbrella (1)', 'closes #6', 'Working now (1)', 'href="#job-job-alpha-9"', 'id="job-job-alpha-9"',
    'Queued (1)', 'Filed improvement', 'Waiting on your decision #14', 'Resolved in the last 7 days', 'decided', 'merged into agent/improvements (stacked)',
    'One job per repo: queued work waits for implement job job-alpha-9', '1 other open issue', 'Vision #1', 'filed #11',
    'GitHub data unavailable', 'Jobs and local readings below are current']) assert.ok(html.includes(label), label);
  assert.match(html, /class="pipe-row umbrella"><a href="https:\/\/github.com\/o\/alpha\/pull\/20"/);
  assert.ok(html.includes('data-slug="o/alpha" open'), 'repos with something blocking are expanded');
  assert.ok(!html.includes('data-slug="o/beta" open'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(p.meta().includes('2 repos in scope · GitHub read 3m ago · refreshes every 5 min'));
});

test('stale, partial and missing readings say so instead of breaking the page', async () => {
  const p = await page({ available: true, fetchedAt: now - 900_000, refreshMs: 300_000, error: 'agentctl overview failed or timed out', overview: { ...overview, paused: true, github: { available: false, errors: ['network down'], truncated: [] } } });
  for (const label of ['The last update failed (agentctl overview failed or timed out). Showing the reading from 15m ago.', 'The pipeline is paused', 'GitHub unavailable (network down)'])
    assert.ok(p.content().includes(label), label);
  p.set({ available: false, error: 'agentctl overview failed or timed out', overview: null });
  await p.context.loadPipeline();
  assert.equal(p.meta(), 'Unavailable');
  assert.ok(p.content().includes('Pipeline overview unavailable (agentctl overview failed or timed out)'));
  p.set(new Error('offline'));
  await p.context.loadPipeline();
  assert.ok(p.content().includes('can’t reach the dashboard server'));
  // Odd shapes from an older agentctl don't throw.
  p.set({ available: true, fetchedAt: now, overview: { version: 1, attention: [], repos: [{ slug: 'o/x', available: true }] } });
  await p.context.loadPipeline();
  assert.ok(p.content().includes('Needs your attention (0)'));
  assert.ok(p.content().includes('Nothing needs you right now.'));
});
