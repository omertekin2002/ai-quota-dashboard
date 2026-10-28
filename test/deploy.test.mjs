import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UPDATE = path.join(ROOT, 'deploy', 'update.sh');
const INSTALL = path.join(ROOT, 'deploy', 'install.sh');
const run = promisify(execFile);

// update.sh is for hp-laptop: it needs util-linux `flock` and GNU `timeout`,
// which e.g. macOS lacks. Skip its tests there rather than fail them.
const hasCommand = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
const missing = ['flock', 'timeout'].filter((cmd) => !hasCommand(cmd));
const updaterTest = (name, fn) =>
  test(name, { skip: process.platform !== 'linux' ? 'update.sh targets Linux' : missing.length ? `needs ${missing.join(', ')}` : false }, fn);

// Git without the user's config, so helpers, hooks and signing can't interfere.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A bare "origin" with main = README + .gitignore, a clone of it as the
// dashboard checkout, a second clone to push new commits from, and a fake
// `systemctl` on PATH that appends its arguments to a log.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqd-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed'), work = path.join(dir, 'work');
  const bin = path.join(dir, 'bin'), calls = path.join(dir, 'systemctl.log');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'clone', '--quiet', origin, seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'v1\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), '.cache/\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'v1');
  git(seed, 'push', '--quiet', 'origin', 'main');
  git(dir, 'clone', '--quiet', origin, work);

  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_SYSTEMCTL_LOG"\n[ ! -e "$FAKE_SYSTEMCTL_FAIL" ]\n', { mode: 0o755 });

  let n = 1;
  const f = {
    dir, origin, seed, work, bin,
    lock: path.join(dir, 'update.lock'),
    failFlag: path.join(dir, 'systemctl.fail'),
    head: (repo = work) => git(repo, 'rev-parse', 'HEAD'),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    // Pushes a new commit to origin/main and returns its SHA.
    advanceOrigin() {
      n += 1;
      fs.writeFileSync(path.join(seed, 'README.md'), `v${n}\n`);
      git(seed, 'commit', '--quiet', '-am', `v${n}`);
      git(seed, 'push', '--quiet', 'origin', 'main');
      return f.head(seed);
    },
    // Runs update.sh against the checkout; resolves with { code, stdout, stderr }.
    update(env = {}) {
      return run('bash', [UPDATE], {
        env: {
          ...process.env, ...GIT_ENV,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          FAKE_SYSTEMCTL_LOG: calls, FAKE_SYSTEMCTL_FAIL: f.failFlag,
          AQD_UPDATE_REPO: work, AQD_UPDATE_LOCK: f.lock, AQD_UPDATE_FETCH_TIMEOUT: '10',
          ...env,
        },
        timeout: 30_000,
      }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }));
    },
  };
  return f;
}

// Everything update.sh must leave alone when it refuses: HEAD, every ref, the
// index file, and every file in the working tree (bytes, including ignored ones).
function snapshot(work) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(work, p);
      if (rel === '.git') continue;
      if (e.isDirectory()) walk(p);
      else files[rel] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(work);
  return {
    head: fs.readFileSync(path.join(work, '.git', 'HEAD'), 'utf8'),
    refs: git(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    index: fs.readFileSync(path.join(work, '.git', 'index')).toString('base64'),
    files,
  };
}

updaterTest('origin/main ahead: fast-forwards and restarts the service exactly once', async (t) => {
  const f = fixture(t);
  const old = f.head(), target = f.advanceOrigin();
  const r = await f.update();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.head(), target);
  assert.equal(fs.readFileSync(path.join(f.work, 'README.md'), 'utf8'), 'v2\n');
  assert.deepEqual(f.calls(), ['--user restart ai-quota-dashboard.service']);
  assert.match(r.stdout, new RegExp(`${old.slice(0, 7)} → ${target.slice(0, 7)}`));
  assert.equal(fs.existsSync(`${f.lock}.restart-pending`), false);
});

updaterTest('already at origin/main: exits 0 without calling systemctl', async (t) => {
  const f = fixture(t);
  const before = f.head();
  const r = await f.update();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.head(), before);
  assert.deepEqual(f.calls(), []);
  assert.match(r.stdout, /nothing to do/);
});

updaterTest('service name and systemctl command can be overridden', async (t) => {
  const f = fixture(t);
  f.advanceOrigin();
  const r = await f.update({ AQD_UPDATE_SERVICE: 'other.service', AQD_UPDATE_SYSTEMCTL: path.join(f.bin, 'systemctl'), PATH: process.env.PATH });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.calls(), ['--user restart other.service']);
});

const refusals = [
  ['a modified tracked file', (f) => fs.writeFileSync(path.join(f.work, 'README.md'), 'local edit\n'), /local changes/],
  ['a staged change', (f) => {
    fs.writeFileSync(path.join(f.work, 'README.md'), 'staged\n');
    git(f.work, 'add', 'README.md');
  }, /local changes/],
  ['an untracked file', (f) => fs.writeFileSync(path.join(f.work, 'notes.txt'), 'mine\n'), /local changes/],
  ['an untracked file in a new directory', (f) => {
    fs.mkdirSync(path.join(f.work, 'scratch'));
    fs.writeFileSync(path.join(f.work, 'scratch', 'a.txt'), 'mine\n');
  }, /local changes/],
  ['a local commit not on origin/main', (f) => {
    fs.writeFileSync(path.join(f.work, 'local.txt'), 'local\n');
    git(f.work, 'add', 'local.txt');
    git(f.work, 'commit', '--quiet', '-m', 'local');
  }, /can't fast-forward/],
  ['a branch other than main', (f) => git(f.work, 'checkout', '--quiet', '-b', 'feature'), /on branch 'feature', not 'main'/],
  ['a detached HEAD', (f) => git(f.work, 'checkout', '--quiet', '--detach'), /detached HEAD/],
];

for (const [name, setup, message] of refusals) {
  updaterTest(`refuses with ${name}: non-zero exit, checkout untouched, no restart`, async (t) => {
    const f = fixture(t);
    f.advanceOrigin();
    setup(f);
    const before = snapshot(f.work);
    const r = await f.update();
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, message);
    assert.deepEqual(snapshot(f.work), before);
    assert.deepEqual(f.calls(), []);
  });
}

// Changes made to the checkout while `git fetch` runs, through a `git` wrapper
// on PATH that runs the change right after the real fetch.
const midFetch = [
  ['switches to another branch', (g) => `${g} checkout --quiet -b feature`, (f, old) => {
    assert.equal(git(f.work, 'rev-parse', 'refs/heads/feature'), old);
    assert.equal(git(f.work, 'rev-parse', 'refs/heads/main'), old);
  }, /on branch 'feature', not 'main'/],
  ['commits on main', (g) => `echo x > local.txt && ${g} add local.txt && ${g} commit --quiet -m local`, (f, old) => {
    assert.equal(git(f.work, 'rev-parse', 'HEAD~1'), old);
  }, /main moved from .* while fetching/],
  ['edits a tracked file', () => 'echo edit > README.md', (f, old) => {
    assert.equal(fs.readFileSync(path.join(f.work, 'README.md'), 'utf8'), 'edit\n');
    assert.equal(f.head(), old);
  }, /local changes/],
];

for (const [name, change, check, message] of midFetch) {
  updaterTest(`refuses when someone ${name} during the fetch`, async (t) => {
    const f = fixture(t);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(f.bin, 'git'), [
      '#!/bin/sh',
      'for a in "$@"; do [ "$a" = fetch ] && is_fetch=1; done',
      `"${realGit}" "$@" || exit $?`,
      `[ -z "$is_fetch" ] || (cd '${f.work}' && ${change(JSON.stringify(realGit))})`,
      '',
    ].join('\n'), { mode: 0o755 });
    const old = f.head();
    f.advanceOrigin();
    const r = await f.update();
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, message);
    check(f, old);
    assert.deepEqual(f.calls(), []);
  });
}

updaterTest('ignored files do not block an update and survive it', async (t) => {
  const f = fixture(t);
  const cache = path.join(f.work, '.cache', 'last-good.json');
  fs.mkdirSync(path.dirname(cache));
  fs.writeFileSync(cache, '{"kept":true}\n');
  const target = f.advanceOrigin();
  const r = await f.update();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.head(), target);
  assert.equal(fs.readFileSync(cache, 'utf8'), '{"kept":true}\n');
  assert.equal(f.calls().length, 1);
});

updaterTest('unreachable remote: non-zero exit, no restart', async (t) => {
  const f = fixture(t);
  git(f.work, 'remote', 'set-url', 'origin', path.join(f.dir, 'missing.git'));
  const before = f.head();
  const r = await f.update();
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(f.head(), before);
  assert.deepEqual(f.calls(), []);
});

updaterTest('a remote asking for credentials fails fast instead of prompting', async (t) => {
  const f = fixture(t);
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  git(f.work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
  // An askpass helper in the environment must not be used either.
  const asked = path.join(f.dir, 'asked');
  const askpass = path.join(f.dir, 'askpass');
  fs.writeFileSync(askpass, `#!/bin/sh\ntouch '${asked}'\necho secret\n`, { mode: 0o755 });
  const started = Date.now();
  const r = await f.update({ GIT_ASKPASS: askpass, SSH_ASKPASS: askpass });
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 10_000, 'should fail well before the fetch timeout');
  assert.equal(fs.existsSync(asked), false);
  assert.deepEqual(f.calls(), []);
});

updaterTest('a remote that never answers is cut off by the fetch timeout', async (t) => {
  const f = fixture(t);
  const sockets = new Set();
  const server = net.createServer((s) => sockets.add(s)); // accepts, never replies
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  git(f.work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
  const started = Date.now();
  const r = await f.update({ AQD_UPDATE_FETCH_TIMEOUT: '2' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /timed out after 2s/);
  assert.ok(Date.now() - started < 15_000);
  assert.deepEqual(f.calls(), []);
});

updaterTest('a run that finds the lock held exits without acting', async (t) => {
  const f = fixture(t);
  const before = f.head();
  f.advanceOrigin();
  const holder = spawn('flock', ['-n', f.lock, '-c', 'echo locked; sleep 30'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  t.after(() => process.kill(-holder.pid, 'SIGKILL')); // the whole group, so `sleep` goes too
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  const r = await f.update();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /another update holds .*skipping/);
  assert.equal(f.head(), before);
  assert.deepEqual(f.calls(), []);
});

updaterTest('a failed restart is retried by the next run', async (t) => {
  const f = fixture(t);
  const target = f.advanceOrigin();
  fs.writeFileSync(f.failFlag, '');
  const first = await f.update();
  assert.notEqual(first.code, 0);
  assert.equal(f.head(), target);
  assert.equal(fs.existsSync(`${f.lock}.restart-pending`), true);

  fs.rmSync(f.failFlag);
  const second = await f.update();
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /last restart failed; retrying/);
  assert.equal(f.calls().length, 2);
  assert.equal(fs.existsSync(`${f.lock}.restart-pending`), false);

  const third = await f.update();
  assert.equal(third.code, 0, third.stderr);
  assert.equal(f.calls().length, 2);
});

test('install.sh is idempotent and writes only its own files', async (t) => {
  const f = fixture(t);
  const home = path.join(f.dir, 'home');
  fs.mkdirSync(home);
  const calls = path.join(f.dir, 'systemctl.log');
  const env = { ...process.env, HOME: home, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, FAKE_SYSTEMCTL_LOG: calls, FAKE_SYSTEMCTL_FAIL: f.failFlag };
  await run('bash', [INSTALL], { env });
  await run('bash', [INSTALL], { env });

  const listed = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else listed.push(path.relative(home, p));
    }
  };
  walk(home);
  assert.deepEqual(listed.sort(), [
    '.config/systemd/user/ai-quota-dashboard-update.service',
    '.config/systemd/user/ai-quota-dashboard-update.timer',
    '.local/lib/ai-quota-dashboard-update/update.sh',
  ]);
  const installed = path.join(home, '.local/lib/ai-quota-dashboard-update/update.sh');
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(UPDATE, 'utf8'));
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
  const once = ['--user daemon-reload', '--user enable --now ai-quota-dashboard-update.timer'];
  assert.deepEqual(f.calls(), [...once, ...once]);
});

test('unit files run the installed updater on a 15-minute timer', () => {
  const service = fs.readFileSync(path.join(ROOT, 'deploy', 'ai-quota-dashboard-update.service'), 'utf8');
  const timer = fs.readFileSync(path.join(ROOT, 'deploy', 'ai-quota-dashboard-update.timer'), 'utf8');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=%h\/\.local\/lib\/ai-quota-dashboard-update\/update\.sh$/m);
  assert.match(service, /^TimeoutStartSec=/m);
  assert.match(timer, /^OnCalendar=\*:0\/15$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});
