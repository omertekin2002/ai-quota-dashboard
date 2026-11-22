import os from 'node:os';
import path from 'node:path';
import { command } from './workspace.mjs';

// Owner settings of the agent pipeline (build-workflow): plans per day, the weekly Claude reserve, and the worker,
// quota and memory limits. The ranges match build-workflow's OWNER_SETTINGS.
// `agentctl settings --json` reads them and `agentctl set <name> <value>` changes them; agentctl validates the
// value and keeps them in ~/.agent-workflow/settings.json, which overrides the repo's config.json. Both commands
// are local and quick (no GitHub), so they run per request rather than on a timer.
const TIMEOUT_MS = 20_000;

// Names the page may change. agentctl knows the ranges; these are checked here too so nothing else reaches it.
export const SETTINGS = {
  maxPlansPerDay: { min: 0, max: 100 }, reservePct: { min: 0, max: 100 },
  maxWorkers: { min: 0, max: 10 }, maxConcurrentPlans: { min: 0, max: 10 },
  fiveHourTightPct: { min: 0, max: 100 }, aheadOfPacePct: { min: 0, max: 100 }, fiveHourStopPct: { min: 0, max: 100 },
  maxStaleMinutes: { min: 10, max: 1440 }, minFreeMemMb: { min: 0, max: 8000 }, memPerWorkerMb: { min: 100, max: 4000 },
};

export class SettingsInputError extends Error {}

function parse(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  return parsed?.version === 1 && parsed.settings && typeof parsed.settings === 'object' ? parsed : null;
}

export function createPipelineSettings({
  run = command, agentctl = process.env.AGENTCTL || path.join(os.homedir(), '.local/bin/agentctl'), timeoutMs = TIMEOUT_MS,
} = {}) {
  async function get() {
    const parsed = parse(await run(agentctl, ['settings', '--json'], { timeout: timeoutMs }));
    if (!parsed) throw new Error('agentctl settings failed or returned an unreadable result');
    return parsed;
  }

  // `changes` is the request body, e.g. { maxPlansPerDay: 6 }. Throws SettingsInputError for a bad request.
  async function set(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new SettingsInputError('send a JSON object of settings');
    const entries = Object.entries(changes);
    if (!entries.length) throw new SettingsInputError('no settings to change');
    for (const [name, value] of entries) {
      const range = Object.hasOwn(SETTINGS, name) ? SETTINGS[name] : null;
      if (!range) throw new SettingsInputError(`unknown setting: ${name}`);
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new SettingsInputError(`${name} must be a whole number from ${range.min} to ${range.max}`);
      }
    }
    let result = null;
    for (const [name, value] of entries) {
      result = parse(await run(agentctl, ['set', name, String(value)], { timeout: timeoutMs }));
      if (!result) throw new Error(`agentctl set ${name} failed`);
    }
    return result;
  }

  return { get, set };
}

export const pipelineSettings = createPipelineSettings();
