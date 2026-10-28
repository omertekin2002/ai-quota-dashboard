import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which commit the dashboard runs, and whether that's still current: the checkout on disk may have moved on
// (restart needed), and upstream `main` may be ahead (pull needed). Only read-only git calls, each with a
// timeout; it never fetches, pulls or writes to the checkout. The snapshot carries short SHAs and flags only,
// never paths, remote URLs or error text.
const DISK_TTL_MS = 60_000; // re-read HEAD on disk at most once a minute
const UPSTREAM_TTL_MS = 15 * 60_000; // `git ls-remote` at most once every 15 minutes
const LOCAL_TIMEOUT_MS = 4000;
const REMOTE_TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // SHA-1 or SHA-256

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Runs git and returns stdout, or null on any failure; the error itself is dropped so it can't leak.
export async function git(args, { cwd, timeout = LOCAL_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec('git', args, {
      cwd, timeout, maxBuffer: 64 * 1024,
      // Never wait on a credential prompt, and never take locks in the checkout.
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch {
    return null;
  }
}

const short = (sha) => (sha ? sha.slice(0, 7) : null);

export function createVersionMonitor({
  run = git, now = Date.now, repoDir = HERE, branch = 'main',
  diskTtlMs = DISK_TTL_MS, upstreamTtlMs = UPSTREAM_TTL_MS,
} = {}) {
  const startedAt = now();
  let commit = null, diskCommit = null, diskCheckedAt = null;
  let upstreamCommit = null, upstreamCheckedAt = null, upstreamError = false;
  let started = null, inflight = null;

  // Any failure, including a runner that throws, reads as "unknown".
  async function gitSha(args, timeout, pick) {
    try {
      const sha = pick(String((await run(args, { cwd: repoDir, timeout })) ?? ''));
      return SHA.test(sha || '') ? sha : null;
    } catch {
      return null;
    }
  }
  const head = () => gitSha(['rev-parse', 'HEAD'], LOCAL_TIMEOUT_MS, (out) => out.trim());

  // Records the commit this process runs. Call it once, at startup.
  function start() {
    started ??= head().then((sha) => {
      commit = diskCommit = sha;
      diskCheckedAt = now();
    });
    return started;
  }

  async function check() {
    await start();
    if (now() - diskCheckedAt >= diskTtlMs) {
      diskCommit = await head();
      diskCheckedAt = now();
    }
    if (upstreamCheckedAt == null || now() - upstreamCheckedAt >= upstreamTtlMs) {
      // Counted as an attempt before it runs, so a slow or failing remote is still asked only once per window.
      upstreamCheckedAt = now();
      const ref = `refs/heads/${branch}`;
      const sha = await gitSha(['ls-remote', 'origin', ref], REMOTE_TIMEOUT_MS,
        (out) => out.split('\n').find((l) => l.split('\t')[1] === ref)?.split('\t')[0]);
      // On failure keep the last known value; upstreamError tells the page it may be old.
      if (sha) upstreamCommit = sha;
      upstreamError = !sha;
    }
  }

  // Brings the cached readings up to date when they're due. Concurrent calls share one check.
  function refresh() {
    inflight ??= check().finally(() => (inflight = null));
    return inflight;
  }

  // The cached state; cheap enough for /healthz, never runs git.
  function snapshot() {
    return {
      commit: short(commit),
      startedAt,
      diskCommit: short(diskCommit),
      upstreamCommit: short(upstreamCommit),
      upstreamCheckedAt,
      upstreamError,
      restartNeeded: Boolean(commit && diskCommit && commit !== diskCommit),
      behindUpstream: Boolean(commit && upstreamCommit && commit !== upstreamCommit),
    };
  }

  return { start, refresh, snapshot };
}

export function startVersionMonitoring(monitor) {
  const tick = () => monitor.refresh().catch(() => {});
  tick();
  // Cheap check; git only runs once a cached reading is due.
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return timer;
}
