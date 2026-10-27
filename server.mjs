#!/usr/bin/env node
// AI quota dashboard: remaining 5-hour / weekly limits for Claude and ChatGPT (Codex) subscriptions.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Returns an http.Server that isn't listening yet. The collectors are injected so tests can use fakes.
export function createDashboardServer({
  getQuotas, getWorkspaceStatus, getPipelineOverview,
  allowedHosts = parseAllowedHosts(), indexFile = path.join(HERE, 'index.html'), log = console.error,
}) {
  const api = { '/api/quotas': getQuotas, '/api/workspace': getWorkspaceStatus, '/api/pipeline': getPipelineOverview };
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
    try {
      if (Object.hasOwn(api, url.pathname)) {
        const data = await api[url.pathname](url.searchParams.has('force'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(indexFile);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
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
    lastGoodFile: path.join(HERE, '.cache', 'last-good.json'),
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(await getQuotas(true), null, 2));
    process.exit(0);
  }

  const server = createDashboardServer({
    getQuotas, getWorkspaceStatus, getPipelineOverview,
    // Extra Host names to answer to, e.g. the MagicDNS name when published with `tailscale serve`.
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI quota dashboard → http://localhost:${port}`);
    startWorkspaceMonitoring();
    startPipelineOverview();
  });
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
