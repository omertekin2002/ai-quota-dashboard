import os from 'node:os';
import path from 'node:path';
import { command } from './workspace.mjs';

// The agent pipeline's per-repo overview comes from `agentctl overview --json` (build-workflow), which
// reads GitHub with one batched GraphQL call and computes "needs you" with the same code as the digest.
// It's refreshed in the background on a fixed interval, never per page load.
const REFRESH_MS = 5 * 60_000; // background refresh
const FORCE_MIN_MS = 60_000; // manual refresh: at most one GitHub round per minute
const TIMEOUT_MS = 90_000;
const MAX_BYTES = 16 * 1024 * 1024;

export function createPipelineOverview({
  run = command, now = Date.now, agentctl = process.env.AGENTCTL || path.join(os.homedir(), '.local/bin/agentctl'),
  refreshMs = REFRESH_MS, forceMinMs = FORCE_MIN_MS, timeoutMs = TIMEOUT_MS,
} = {}) {
  let overview = null, fetchedAt = null, attemptedAt = null, error = null, inflight = null;

  async function refresh() {
    attemptedAt = now();
    const raw = await run(agentctl, ['overview', '--json'], { timeout: timeoutMs, maxBuffer: MAX_BYTES });
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (parsed?.version === 1 && Array.isArray(parsed.repos) && Array.isArray(parsed.attention)) {
      overview = parsed;
      fetchedAt = now();
      error = null;
    } else {
      // Keep the last good reading; the page marks it as old.
      error = raw == null ? 'agentctl overview failed or timed out' : 'agentctl overview returned an unreadable result';
    }
  }

  const snapshot = () => ({
    available: overview != null, fetchedAt, attemptedAt, error, refreshing: inflight != null, refreshMs,
    nextRefreshAt: attemptedAt != null ? attemptedAt + refreshMs : null, overview,
  });

  return async function get(force = false) {
    const age = attemptedAt == null ? Infinity : now() - attemptedAt;
    if (!inflight && (age >= refreshMs || (force && age >= forceMinMs))) {
      inflight = refresh().catch((e) => { error = String(e?.message || e); }).finally(() => { inflight = null; });
    }
    // Wait for the first reading, or for a manual refresh; otherwise answer from the cache at once.
    if (inflight && (force || overview == null)) await inflight;
    return snapshot();
  };
}

export const getPipelineOverview = createPipelineOverview();

export function startPipelineOverview(get = getPipelineOverview) {
  const tick = () => get().catch(() => {});
  tick();
  // Cheap check; GitHub is only read once the cached reading is refreshMs old.
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return timer;
}
