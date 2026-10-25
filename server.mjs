#!/usr/bin/env node
// AI quota dashboard: remaining 5-hour / weekly limits for Claude and ChatGPT (Codex) subscriptions.
//
//   node server.mjs          serve the dashboard on http://localhost:7417
//   node server.mjs --json   print current quotas as JSON and exit
//
// Quota collection lives in quotas.mjs; this file is the HTTP server and the command line.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuotaCollector } from './quotas.mjs';
import { parseAllowedHosts, isAllowedHost } from './hosts.mjs';
import { getWorkspaceStatus, startWorkspaceMonitoring } from './workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 7417);
// Extra Host names to answer to, e.g. the MagicDNS name when published with `tailscale serve`.
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);
const getQuotas = createQuotaCollector({
  home: HOME,
  authDir: expand(process.env.CLIPROXY_AUTH_DIR || '~/.cli-proxy-api'),
  codexHome: expand(process.env.CODEX_HOME || '~/.codex'),
  lastGoodFile: path.join(HERE, '.cache', 'last-good.json'),
});

function expand(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

// ---------- entry points ----------

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(await getQuotas(true), null, 2));
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to known hosts, so other websites can't read this via DNS rebinding.
  if (!isAllowedHost(req.headers.host, ALLOWED_HOSTS)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/quotas') {
      const data = await getQuotas(url.searchParams.has('force'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } else if (url.pathname === '/api/workspace') {
      const data = await getWorkspaceStatus(url.searchParams.has('force'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(HERE, 'index.html')));
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI quota dashboard → http://localhost:${PORT}`);
  startWorkspaceMonitoring();
});
