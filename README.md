# ai-quota-dashboard

A local dashboard showing how much of your **5-hour** and **weekly** limits is left on Claude and ChatGPT (Codex) subscriptions.

No dependencies, no build step. Needs Node 18+.

```sh
npm start            # http://localhost:7417
npm run json         # print current quotas as JSON and exit
```

## What it shows

For each account and limit window, including model-specific ones such as Claude's Fable-only weekly limit when your plan has one:

- how much is left, as a % with a meter
- a countdown to the reset and the reset time
- a **Low** warning (≤30% left) or **Nearly out** warning (≤10% left)
- a pace projection: how much will be left at the reset if you keep the current rate
- a tick on the meter marking how much of the window's time is left. If the bar ends left of the tick, you're using the quota faster than it refills.

Hover a window for exact numbers. The **Table** button shows everything as a table. The page updates every 2 minutes, and the tab title shows the tightest window per account.

## Agent pipeline

The **Agent pipeline** panel shows the state of the [build-workflow](https://github.com/omertekin2002/build-workflow) agent pipeline for every repo in its scope. Repos excluded in its `config.json` don't appear. Everything links to GitHub.

- **Needs your attention**, across all repos: issues blocked on you (`agent:needs-human`, noting the decision that unblocks one), decisions to answer, umbrella PRs ready to review and merge, agent PRs waiting for review, and local checkouts the pump couldn't sync. Each item names the exact action. It's the same list as the daily digest's, because both come from the same build-workflow code. Items the digest still lists for out-of-scope repos are only counted.
- **Per repo**, expanded automatically when something there is blocked on you:
  - open PRs, with the umbrella PR highlighted;
  - the PRs stacked into the umbrella since the last one merged;
  - pending issues: working now (with the job and its PR), queued (in the pump's order), and blocked;
  - why queued work isn't moving, if something holds it: a running job, a pause, a rejected umbrella, or the local checkout;
  - your answers that agents are still acting on;
  - issues closed and PRs merged in the last 7 days;
  - active and recently finished jobs, with their summaries.

The data comes from `agentctl overview --json` in build-workflow. That command is read-only, and reads GitHub with one batched `gh api graphql` call. The server runs it in the background every 5 minutes, whether or not a page is open, and serves the cached result at `/api/pipeline`. **Refresh** forces a new reading, at most once a minute. The page re-reads the cache every minute and shows when GitHub was last read. If a run fails, the last reading stays visible with a warning. A repo GitHub returned nothing for is marked unavailable, while its jobs and local readings still show. The `agentctl` path defaults to `~/.local/bin/agentctl`; override it with `AGENTCTL`.

Unlike the process panel below, this panel publishes GitHub issue and PR titles and job summaries. Keep the dashboard tailnet-only.

## Workspace computer

On Linux, the **Workspace computer** panel reports the computer running the dashboard:

- Battery state of charge, charging state, and AC power.
- CPU temperature, plus GPU and SSD temperatures when their sensors are readable.
- Memory usage (using Linux's available-memory reading), swap usage, and uptime.
- The connected Wi-Fi network's name (SSID), or the wired connection's name, along with internet reachability and the HTTPS check's response time. Either Google's or Cloudflare's connectivity endpoint can confirm access; NetworkManager helps distinguish a disconnected link, limited connectivity, and a sign-in portal when both checks fail.
- Whether **CLIProxyAPI**, **ngrok-proxy-llm**, **T3 Code**, **Tailscale**, and the **network watchdog** are running, with automatic restart counts and service uptime. HTTP checks separately verify T3's local page and Tailscale route, CLIProxyAPI's `/healthz`, the retry proxy's backend-aware `/health`, and its public ngrok route. They don't send LLM requests or refresh credentials.

Below the quota cards, **Computer diagnostics** adds:

- Linux CPU, memory, and I/O pressure (the share of time tasks were stalled over the last 10 seconds), plus the five largest processes by resident memory. The top-memory list shows executable names and PIDs, without arguments or environments. Memory warnings use available RAM and pressure: warning at ≤10% available, ≥10% partial stalls, or ≥1% full stalls; critical at ≤5% available or ≥10% full stalls.
- Internal SSD and T7 free space, actual T7 mount presence, read-only mount detection, and the last backup result, last known success, and next scheduled run. An autofs placeholder does not count as a mounted T7. A previous successful backup remains recorded if a later run fails; the last-success time is unknown if monitoring starts after a failure with no earlier record.
- Wi-Fi signal and link rate, active Tailscale peer connection types/counts, and a 30-minute history of HTTPS response times and unsuccessful internet checks. Link rate is not measured internet speed; the Tailscale view shows active connections, not a client-specific speed test.
- A recent-events timeline for observed service state changes/restarts, failed/recovered HTTP checks, internet/network changes, link-drop and OOM-kill counter increases, memory pressure, storage changes, and backup results. Events are sampled, not a complete historical log; brief changes can fall between readings. Monitoring starts tracking on installation, with the current backup result seeded from systemd.

### Agentctl & build-workflow

The diagnostics include a dedicated process/pipeline panel:

- Matches `agentctl` script entrypoints, processes working inside the build-workflow checkout, its T3 worktrees, or `~/.agent-workflow`, and their descendants. Unrelated agents or shell commands merely mentioning these names are excluded. An observed child remains tracked if reparented, using its PID and Linux start-time identity to avoid confusing a reused PID with the original process. That detached-child association lasts for the dashboard process lifetime.
- Shows PID/parent, role, process state, elapsed time, lifetime-average CPU percentage, individual RSS, and combined totals. Shared memory can be counted more than once in summed RSS. At most 100 process rows are displayed.
- Reads `agent-pump.service` and its timer. An inactive successful oneshot pump is **idle**, not a failure. It shows paused/quota-waiting state and the last tick without invoking `agentctl` or changing the pipeline.
- Shows today's plan launches against the configured `maxPlansPerDay` limit, remaining launches, and the next reset at midnight UTC (displayed in your local time). The count comes from the pump's `plansByDay` state, including launches that later fail; tasks and implementation runs don't use this cap. Missing or invalid readings show as unavailable.
- Reads selected job-record fields: ID, mode, status, timestamps, and whether launch/heartbeat deadlines are overdue. These are independent of OS process counts, because T3 workers can continue while no CLI command runs. Configured `staleMinutes` and `launchTimeoutMinutes` are respected (fallbacks: 60 and 15 minutes). The first 20 active and five recent completed records are shown; up to 500 most recently modified records are inspected, with partial readings marked.
- Adds observed process starts/exits, stopped/zombie states, pump/timer/pause changes, job status changes, and overdue/recovered heartbeats to the existing event timeline. Missing sources do not generate false process exits.

For script identification, the monitor briefly inspects a bounded local command-line prefix and working directory. Neither is returned by the API or saved in history. Prompts, arguments, job titles, notes, summaries, environments, and the workflow's `secrets` directory are not published. Monitoring does not launch, pause, kill, or modify jobs. Default paths and matching rules are in `agent-workflow.mjs`; the workflow state directory honors `AGENT_HOME`.

The server samples computer readings every 30 seconds even when no browser page is open. The page updates its computer panel every 30 seconds while visible. **Refresh** updates both computer readings and quotas. `/api/workspace` has its own 15-second cache (manual refresh: 5 seconds), independent from provider requests. Missing sensors or inaccessible services show as unavailable or unknown. If an update fails, the last reading stays visible with a warning.

The public ngrok HTTP check runs at most once every 15 minutes, including on manual refresh, to limit requests against its allowance. Its reading has a separate check timestamp; local health checks still run with each computer collection. Only the retry proxy's existing HTTPS ngrok tunnel is used, with a fixed `/health` path and redirects disabled. All HTTP probes have bounded timeouts and response sizes.

History is stored atomically in `.cache/workspace-history.json`: up to 100 events over seven days and 80 latency samples covering up to 30 minutes. It survives dashboard restarts. It contains selected status readings only, not raw journal logs, peer addresses, tokens, or credentials. A save failure is shown in the events panel.

Monitoring reads `/sys`, `/proc`, selected `systemctl show` properties, process memory, filesystem space, NetworkManager, and Tailscale status, and makes bounded HTTP(S) checks. It never controls services or changes power/network settings. The monitored units are listed in `workspace.mjs`, and health endpoints in `diagnostics.mjs`; unsupported operating systems still show quotas normally. No new packages or elevated privileges are needed.

Run `npm test` for quota parsing (Claude and Codex usage windows, plans, credential discovery, last-good fallback, the Host allow-list), collectors, HTTP payload validation, missing mounts, backup failures, event persistence, network quality, UI rendering/escaping, and caching checks.

GitHub Actions (`.github/workflows/test.yml`) syntax-checks the modules and runs `npm test` on Node 18, 20, 22 and 24 for every pull request into `main` or `agent/improvements`.

## Where the credentials come from

Accounts are discovered automatically. When the same account appears in several places, it's shown once.

| Provider | Sources |
|---|---|
| Claude | macOS Keychain item `Claude Code-credentials`, `~/.claude/.credentials.json`, CLIProxyAPI `claude-*.json` |
| ChatGPT / Codex | `~/.codex/auth.json`, CLIProxyAPI `codex-*.json` |

CLIProxyAPI is optional. The dashboard only reads its auth folder (`~/.cli-proxy-api`, the one VibeProxy uses). When the proxy is running, it keeps those tokens fresh.

Usage numbers come from `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`. These are the same endpoints the Claude Code and Codex apps call. They're unofficial and may change.

## Running on another machine via Tailscale

On Linux, the Claude login is read from `~/.claude/.credentials.json`; the Codex and CLIProxyAPI files are the same as on macOS. To reach the dashboard from your other tailnet devices:

```sh
tailscale serve --bg --https=7417 http://127.0.0.1:7417
ALLOWED_HOSTS=<machine>.<tailnet>.ts.net npm start
```

The tailnet URL is `https://<machine>.<tailnet>.ts.net:7417`. Choose a free HTTPS port; omitting `--https` would use port 443 and could replace another app's route. `tailscale serve` passes the MagicDNS name through as the `Host` header, so that name has to be in `ALLOWED_HOSTS`.

The dashboard is tailnet-only: by the owner's decision ([#7](https://github.com/omertekin2002/ai-quota-dashboard/issues/7)) it must only be reachable from devices on the tailnet. Don't enable Tailscale Funnel for it, because Funnel publishes it to the public internet. On this laptop it's served on port 8443 with a tailnet-only Serve route:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7417
```

## Notes

- **Tokens are never refreshed or written back.** Both providers' refresh tokens are one-time-use, so refreshing them here would log the CLIs out. When a token has expired, the card shows the last successful reading, marked as old, until you run `claude` or `codex` once.
- The last successful reading is stored in `.cache/last-good.json`. It holds usage numbers and emails only, no tokens.
- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't `localhost`/`127.0.0.1` or listed in `ALLOWED_HOSTS`. That stops other websites from reading it through DNS rebinding.
- Upstream calls are cached for 90 seconds, and the Claude plan lookup for 15 minutes. Pressing **Refresh** bypasses both, at most once every 15 seconds.

| Env var | Default |
|---|---|
| `PORT` | `7417` |
| `CLIPROXY_AUTH_DIR` | `~/.cli-proxy-api` |
| `CODEX_HOME` | `~/.codex` |
| `ALLOWED_HOSTS` | (empty) — comma-separated extra hostnames to accept, e.g. your Tailscale MagicDNS name |
| `AGENTCTL` | `~/.local/bin/agentctl` — the build-workflow CLI the pipeline panel runs |
