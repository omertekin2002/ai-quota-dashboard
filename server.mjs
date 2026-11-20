#!/usr/bin/env node
// AI quota dashboard: remaining limits for Claude, ChatGPT (Codex) and Antigravity.
//
//   node server.mjs          serve the dashboard on http://localhost:7417
//   node server.mjs --json   print current quotas as JSON and exit
//
// Quota collection lives in quotas.mjs; this file is the HTTP server and the command line.
// Importing it has no side effects: the server only starts when the file is run directly.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuotaCollector } from './quotas.mjs';
import { parseAllowedHosts, isAllowedHost } from './hosts.mjs';
import { getWorkspaceStatus, startWorkspaceMonitoring } from './workspace.mjs';
import { getPipelineOverview, startPipelineOverview } from './pipeline-overview.mjs';
import { createVersionMonitor, startVersionMonitoring } from './version.mjs';
import { pipelineSettings, SettingsInputError } from './pipeline-settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UNKNOWN_VERSION = { commit: null, startedAt: null, restartNeeded: false, behindUpstream: false };
const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The only request that changes anything. A page on another site could still POST here from the owner's browser
// (the Host header is ours then), so writes also need a JSON body, which a plain form can't send, and an Origin
// header naming one of our hosts.
async function readJsonBody(req, allowedHosts) {
  let origin = null;
  try { origin = new URL(req.headers.origin).host; } catch {}
  if (!origin || !isAllowedHost(origin, allowedHosts)) throw new HttpError(403, 'cross-origin request refused');
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'send JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

// Returns an http.Server that isn't listening yet. The collectors are injected so tests can use fakes.
// `getVersion` returns cached state only (see version.mjs), so /healthz never waits on git or a collector.
export function createDashboardServer({
  getQuotas, getWorkspaceStatus, getPipelineOverview, getVersion = () => UNKNOWN_VERSION, settings = pipelineSettings,
  allowedHosts = parseAllowedHosts(), indexFile = path.join(HERE, 'index.html'), log = console.error,
}) {
  const api = {
    '/api/quotas': getQuotas, '/api/workspace': getWorkspaceStatus, '/api/pipeline': getPipelineOverview,
    '/api/version': async () => getVersion(),
    '/healthz': async () => ({ ok: true, ...getVersion(), uptimeSec: Math.floor(process.uptime()) }),
  };
  return http.createServer(async (req, res) => {
    // Only answer requests addressed to known hosts, so other websites can't read this via DNS rebinding.
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      res.writeHead(403).end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // e.g. `GET http://[ HTTP/1.1`; throwing here would crash the process.
      res.writeHead(400).end();
      return;
    }
    const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    try {
      if (url.pathname === '/api/pipeline/settings') {
        if (req.method === 'GET') send(200, await settings.get());
        else if (req.method === 'POST') send(200, await settings.set(await readJsonBody(req, allowedHosts)));
        else res.writeHead(405, { Allow: 'GET, POST' }).end();
      } else if (Object.hasOwn(api, url.pathname)) {
        const data = await api[url.pathname](url.searchParams.has('force'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(indexFile);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      if (err instanceof HttpError || err instanceof SettingsInputError) {
        if (res.headersSent) return void res.destroy();
        return void send(err.status || 400, { error: err.message });
      }
      // Error messages can carry paths or tokens, so they stay in the server log.
      log(`${req.method} ${url.pathname} failed:`, err);
      if (res.headersSent) return void res.destroy();
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
    }
  });
}

// ---------- entry points ----------

async function main(argv = process.argv) {
  const home = os.homedir();
  const expand = (p) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p);
  const port = Number(process.env.PORT || 7417);
  const getQuotas = createQuotaCollector({
    home,
    authDir: expand(process.env.CLIPROXY_AUTH_DIR || '~/.cli-proxy-api'),
    codexHome: expand(process.env.CODEX_HOME || '~/.codex'),
    t3StateDir: expand(process.env.T3_STATE_DIR || '~/.t3/userdata'),
    lastGoodFile: path.join(HERE, '.cache', 'last-good.json'),
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(await getQuotas(true), null, 2));
    process.exit(0);
  }

  const version = createVersionMonitor();
  await version.start();
  const server = createDashboardServer({
    getQuotas, getWorkspaceStatus, getPipelineOverview, getVersion: version.snapshot,
    // Extra Host names to answer to, e.g. the MagicDNS name when published with `tailscale serve`.
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
  });
  const timers = [];
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI quota dashboard → http://localhost:${server.address().port}`);
    timers.push(startWorkspaceMonitoring(), startPipelineOverview(), startVersionMonitoring(version));
  });

  // systemd stops the service with SIGTERM. Stop taking requests, let open ones finish, then exit 0.
  // Workspace history is written to a temp file and renamed into place, so there's nothing buffered to flush
  // and an exit mid-write leaves the previous history intact.
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    for (const timer of timers) clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.(); // keep-alive sockets would otherwise hold close() open (Node < 19)
    // Don't let a slow request hold up the stop.
    setTimeout(() => {
      console.error('Requests still open after 4 seconds; exiting anyway');
      process.exit(0);
    }, 4000).unref();
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
}

// True when this file is the program being run (`node server.mjs`), not an import.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
