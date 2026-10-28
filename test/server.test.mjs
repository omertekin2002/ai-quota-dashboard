import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDashboardServer } from '../server.mjs';
import { parseAllowedHosts } from '../hosts.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'sk-ant-oat01-FAKE-TOKEN-for-tests';

// Starts a dashboard on a free port with fake collectors that record their `force` argument.
async function start(t, overrides = {}) {
  const calls = { quotas: [], workspace: [], pipeline: [] };
  const logged = [];
  const fake = (name) => async (force) => {
    calls[name].push(force);
    return { source: name };
  };
  const server = createDashboardServer({
    getQuotas: fake('quotas'),
    getWorkspaceStatus: fake('workspace'),
    getPipelineOverview: fake('pipeline'),
    allowedHosts: parseAllowedHosts('dash.example.ts.net'),
    log: (...args) => logged.push(args),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  // `host: null` sends no Host header at all.
  function get(pathname, host = `localhost:${port}`) {
    const headers = host == null ? {} : { Host: host };
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathname, headers, setHost: host != null }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }
  return { get, calls, logged, port };
}

test('importing the server module starts no server, timers or requests', async () => {
  const script = "const m = await import('./server.mjs'); console.log(typeof m.createDashboardServer)";
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, timeout: 5000 });
  assert.equal(stdout.trim(), 'function');
});

test('requests for other hosts get 403 and reach no collector', async (t) => {
  const { get, calls } = await start(t);
  for (const host of ['evil.example', 'evil.example:7417', 'localhost.evil.example', 'dash.example.ts.net.evil.example', null]) {
    for (const pathname of ['/', '/api/quotas', '/api/workspace', '/api/pipeline']) {
      const res = await get(pathname, host);
      // Node itself answers 400 to HTTP/1.1 requests with no Host header (requireHostHeader).
      assert.ok((host == null ? [400, 403] : [403]).includes(res.status), `${host} ${pathname}: ${res.status}`);
      assert.equal(res.body, '');
    }
  }
  assert.deepEqual(calls, { quotas: [], workspace: [], pipeline: [] });
});

test('localhost, 127.0.0.1 and ALLOWED_HOSTS names are accepted', async (t) => {
  const { get, port } = await start(t);
  for (const host of [`localhost:${port}`, 'localhost', `127.0.0.1:${port}`, 'dash.example.ts.net', 'DASH.example.ts.net:443']) {
    assert.equal((await get('/api/quotas', host)).status, 200, host);
  }
});

test('API routes return uncached JSON and pass force through only when asked', async (t) => {
  const { get, calls } = await start(t);
  for (const [route, name] of [['/api/quotas', 'quotas'], ['/api/workspace', 'workspace'], ['/api/pipeline', 'pipeline']]) {
    for (const query of ['', '?force', '?force=1', '?other=1']) {
      const res = await get(route + query);
      assert.equal(res.status, 200, route + query);
      assert.equal(res.headers['content-type'], 'application/json');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(res.body), { source: name });
    }
    assert.deepEqual(calls[name], [false, true, true, false]);
  }
});

test('the page is served as HTML at / and /index.html', async (t) => {
  const { get } = await start(t);
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  for (const pathname of ['/', '/index.html', '/?force']) {
    const res = await get(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.body, html);
  }
});

test('unknown paths get 404 without calling a collector', async (t) => {
  const { get, calls } = await start(t);
  for (const pathname of ['/nope', '/api', '/api/quotas/extra', '/api/toString', '/api/__proto__', '/index.htm']) {
    const res = await get(pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.body, '');
  }
  assert.deepEqual(calls, { quotas: [], workspace: [], pipeline: [] });
});

test('a failing collector gets a generic 500 and the error is only logged', async (t) => {
  const failure = new Error(`token ${SECRET} rejected at /home/someone/.codex/auth.json`);
  const { get, logged } = await start(t, { getWorkspaceStatus: async () => { throw failure; } });
  const res = await get('/api/workspace?force');
  assert.equal(res.status, 500);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
  assert.ok(!res.body.includes(SECRET));
  assert.ok(!res.body.includes('.codex'));
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /\/api\/workspace/);
  assert.equal(logged[0][1], failure);
  // Other routes keep working.
  assert.equal((await get('/api/quotas')).status, 200);
});

test('an unreadable page file gets a generic 500 too', async (t) => {
  const { get, logged } = await start(t, { indexFile: path.join(ROOT, 'test', `missing-${SECRET}.html`) });
  const res = await get('/');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
  assert.ok(!res.body.includes(SECRET));
  assert.equal(logged.length, 1);
});

test('a malformed request URL gets 400 and the server keeps running', async (t) => {
  const { get, port, calls, logged } = await start(t);
  const reply = await new Promise((resolve, reject) => {
    let data = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.equal((await get('/api/quotas')).status, 200);
  assert.deepEqual(calls.quotas, [false]);
  assert.equal(logged.length, 0);
});

const VERSION = {
  commit: 'aaaaaaa', startedAt: 1_000_000, diskCommit: 'bbbbbbb', upstreamCommit: 'ccccccc',
  upstreamCheckedAt: 1_000_000, upstreamError: false, restartNeeded: true, behindUpstream: true,
};

test('/healthz answers from cached state without calling a collector', async (t) => {
  let versionCalls = 0;
  const { get, calls } = await start(t, { getVersion: () => (versionCalls++, VERSION) });
  for (const pathname of ['/healthz', '/healthz?force']) {
    const res = await get(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual({ ...body, ok: undefined, uptimeSec: undefined }, { ...VERSION, ok: undefined, uptimeSec: undefined });
    assert.ok(Number.isInteger(body.uptimeSec) && body.uptimeSec >= 0);
  }
  assert.equal(versionCalls, 2);
  assert.deepEqual(calls, { quotas: [], workspace: [], pipeline: [] });
});

test('/healthz and /api/version get 403 for other hosts', async (t) => {
  let versionCalls = 0;
  const { get } = await start(t, { getVersion: () => (versionCalls++, VERSION) });
  for (const pathname of ['/healthz', '/api/version']) {
    const res = await get(pathname, 'evil.example');
    assert.equal(res.status, 403);
    assert.equal(res.body, '');
  }
  assert.equal(versionCalls, 0);
});

test('/api/version returns the version state, and an unknown version without a monitor', async (t) => {
  const { get } = await start(t, { getVersion: () => VERSION });
  const res = await get('/api/version');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), VERSION);

  const plain = await start(t);
  const health = JSON.parse((await plain.get('/healthz')).body);
  assert.equal(health.ok, true);
  assert.equal(health.commit, null);
  assert.equal(JSON.parse((await plain.get('/api/version')).body).commit, null);
});

test('the real /healthz output carries no paths, remote URLs or error text', async (t) => {
  const { createVersionMonitor } = await import('../version.mjs');
  // A git that fails loudly, mentioning a path and a remote URL.
  const monitor = createVersionMonitor({
    repoDir: '/home/someone/checkout',
    run: async () => { throw new Error('fatal: could not read from https://token@github.example/x.git at /home/someone/checkout'); },
  });
  await monitor.start();
  await monitor.refresh();
  const { get } = await start(t, { getVersion: monitor.snapshot });
  for (const pathname of ['/healthz', '/api/version']) {
    const { body } = await get(pathname);
    for (const leak of ['fatal', '/home', 'github.example', 'token', 'https:']) assert.ok(!body.includes(leak), `${pathname}: ${leak}`);
    assert.equal(JSON.parse(body).commit, null);
  }
});

test('SIGTERM stops a running `node server.mjs` with exit code 0 within 5 seconds', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    // Port 0 picks a free port; a missing agentctl keeps the test off GitHub.
    env: { ...process.env, PORT: '0', AGENTCTL: path.join(ROOT, 'test', 'no-such-agentctl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    let out = '';
    child.stdout.setEncoding('utf8');
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const m = out.match(/localhost:(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      exited.then(() => reject(new Error(`server exited early: ${out}`)));
    });
    // Hold a keep-alive connection open, the way a browser tab does.
    const agent = new http.Agent({ keepAlive: true });
    const health = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { Host: 'localhost' }, agent }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(health.status, 200);
    const head = (await promisify(execFile)('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT }).catch(() => null))?.stdout.trim() ?? null;
    assert.equal(JSON.parse(health.body).commit, head);

    const sentAt = Date.now();
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.ok(Date.now() - sentAt < 5000, `took ${Date.now() - sentAt} ms`);
    agent.destroy();
  } finally {
    child.kill('SIGKILL');
  }
});
