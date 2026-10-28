import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createVersionMonitor, git } from '../version.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const REPO = '/home/someone/secret-checkout';
const REMOTE = 'https://token@github.example/someone/repo.git';

// A fake git: `state.head` / `state.upstream` are SHAs, or null to make that command fail.
function fakeGit(state) {
  const calls = [];
  const run = async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'rev-parse') return state.head == null ? null : `${state.head}\n`;
    if (args[0] === 'ls-remote') return state.upstream == null ? null : `${state.upstream}\trefs/heads/main\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { run, calls, count: (cmd) => calls.filter((c) => c.args[0] === cmd).length };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function monitor(state, overrides = {}) {
  const g = fakeGit(state), c = clock();
  const m = createVersionMonitor({ run: g.run, now: c.now, repoDir: REPO, ...overrides });
  return { m, g, c };
}

test('running == disk == upstream: short SHAs and no warning', async () => {
  const { m, g } = monitor({ head: A, upstream: A });
  await m.start();
  await m.refresh();
  assert.deepEqual(m.snapshot(), {
    commit: 'aaaaaaa', startedAt: 1_000_000, diskCommit: 'aaaaaaa', upstreamCommit: 'aaaaaaa',
    upstreamCheckedAt: 1_000_000, upstreamError: false, restartNeeded: false, behindUpstream: false,
  });
  // Read-only commands only, run in the checkout, each with a timeout.
  assert.deepEqual(g.calls.map((c) => c.args), [['rev-parse', 'HEAD'], ['ls-remote', 'origin', 'refs/heads/main']]);
  for (const { opts } of g.calls) {
    assert.equal(opts.cwd, REPO);
    assert.ok(opts.timeout > 0 && opts.timeout <= 15_000);
  }
});

test('a new commit on disk means a restart is needed', async () => {
  const state = { head: A, upstream: B };
  const { m, c } = monitor(state);
  await m.start();
  state.head = B;
  await m.refresh();
  // HEAD on disk is cached for a minute.
  assert.equal(m.snapshot().diskCommit, 'aaaaaaa');
  assert.equal(m.snapshot().restartNeeded, false);
  c.advance(60_000);
  await m.refresh();
  const s = m.snapshot();
  assert.equal(s.commit, 'aaaaaaa');
  assert.equal(s.diskCommit, 'bbbbbbb');
  assert.equal(s.restartNeeded, true);
  assert.equal(s.behindUpstream, true);
});

test('upstream main moving on means the server is behind', async () => {
  const { m } = monitor({ head: A, upstream: C });
  await m.start();
  await m.refresh();
  const s = m.snapshot();
  assert.equal(s.upstreamCommit, 'ccccccc');
  assert.equal(s.restartNeeded, false);
  assert.equal(s.behindUpstream, true);
});

test('git missing or failing: commit is null, nothing throws, no error text', async () => {
  for (const run of [
    fakeGit({ head: null, upstream: null }).run,
    async () => 'fatal: not a git repository (or any of the parent directories): .git\n',
    async () => { throw new Error(`spawn git ENOENT in ${REPO} for ${REMOTE}`); },
  ]) {
    const m = createVersionMonitor({ run, repoDir: REPO });
    await m.start();
    await m.refresh();
    const s = m.snapshot();
    assert.equal(s.commit, null);
    assert.equal(s.diskCommit, null);
    assert.equal(s.upstreamCommit, null);
    assert.equal(s.restartNeeded, false);
    assert.equal(s.behindUpstream, false);
    const json = JSON.stringify(s);
    for (const leak of ['fatal', 'ENOENT', REPO, 'secret-checkout', 'github.example', 'token']) assert.ok(!json.includes(leak), leak);
  }
});

test('the real git runner returns null instead of throwing, with no error text', async () => {
  assert.equal(await git(['rev-parse', 'HEAD'], { cwd: path.join(ROOT, 'does-not-exist') }), null);
  assert.equal(await git(['no-such-subcommand-xyz'], { cwd: ROOT }), null);
});

test('a failed upstream check keeps the last value and only sets the error flag', async () => {
  const state = { head: A, upstream: B };
  const { m, c } = monitor(state);
  await m.start();
  await m.refresh();
  state.upstream = null;
  c.advance(15 * 60_000);
  await m.refresh();
  const s = m.snapshot();
  assert.equal(s.upstreamCommit, 'bbbbbbb');
  assert.equal(s.upstreamError, true);
  assert.equal(s.upstreamCheckedAt, 1_000_000 + 15 * 60_000);
  assert.equal(s.behindUpstream, true);
  state.upstream = A;
  c.advance(15 * 60_000);
  await m.refresh();
  assert.equal(m.snapshot().upstreamError, false);
  assert.equal(m.snapshot().behindUpstream, false);
});

test('ls-remote runs at most once every 15 minutes, failures included', async () => {
  const state = { head: A, upstream: null };
  const { m, g, c } = monitor(state);
  await m.start();
  await m.refresh();
  assert.equal(g.count('ls-remote'), 1);
  for (let i = 0; i < 14; i++) {
    c.advance(60_000);
    await Promise.all([m.refresh(), m.refresh()]);
  }
  assert.equal(g.count('ls-remote'), 1);
  // HEAD on disk was re-read about once a minute meanwhile.
  assert.equal(g.count('rev-parse'), 15);
  c.advance(60_000);
  await m.refresh();
  assert.equal(g.count('ls-remote'), 2);
});

test('the snapshot is cached state and never runs git', async () => {
  const { m, g } = monitor({ head: A, upstream: A });
  assert.equal(m.snapshot().commit, null);
  await m.start();
  const before = g.calls.length;
  for (let i = 0; i < 5; i++) m.snapshot();
  assert.equal(g.calls.length, before);
});

test('in this checkout, the commit matches git rev-parse', async (t) => {
  const head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).catch(() => null))?.stdout.trim();
  if (!head) return t.skip('not a git checkout');
  const m = createVersionMonitor({ repoDir: ROOT });
  await m.start();
  assert.equal(m.snapshot().commit, head.slice(0, 7));
  assert.equal(m.snapshot().diskCommit, head.slice(0, 7));
});
