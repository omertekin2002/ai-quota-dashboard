# ai-quota-dashboard

A local dashboard showing how much of your **5-hour** and **weekly** limits is left on Claude, ChatGPT (Codex), and Google Antigravity subscriptions.

No dependencies, no build step. Needs Node 18+.

```sh
npm start            # http://localhost:7417
npm run json         # print current quotas as JSON and exit
```

## What it shows

At the top, an **At a glance** strip answers three questions before you scroll. Each tile's title links to its full panel:

- **Capacity**: one line per account with its tightest known window, its % left, the reset countdown and the same **⚠ Low** / **⛔ Nearly out** text as the cards. A stale account shows its reading age (◷), an account with no readable usage shows `—`, and a window past its reset says "Estimated". Accounts are never added up or compared with each other, because a percentage of one subscription isn't the same capacity as a percentage of another.
- **Needs you**: how many items in the [Agent pipeline](#agent-pipeline)'s "Needs your attention" list are waiting on you, counted by kind (for example "2 blocked · 1 decision · 1 umbrella to merge"), with 🔥 when one is urgent. Otherwise it says "Nothing needs you".
- **Workspace**: "All OK" when every [Workspace computer](#workspace-computer) reading is healthy. Otherwise it counts the critical (⛔) and warning (⚠) conditions and names the first two, such as "⛔ CLIProxyAPI check failed". The tile and the panels use the same level rules for services and their HTTP checks, memory, internet, battery, temperature, disks, the T7 backup and the auto-updater, so the two can't disagree.

The strip adds no requests. It's built from the quota, pipeline and computer readings the page already loads, and it redraws whenever one of them does. When a source can't be read, only its own tile says so: "⚠ Couldn't refresh" with the age of the last reading, or "Unavailable" when there's none yet.

Below the strip, the panels come in the same order as its tiles: the quota cards, then the [Agent pipeline](#agent-pipeline), then the [Workspace computer](#workspace-computer) with its Computer diagnostics. While nothing needs you, the Agent pipeline panel is a single line, and so is the computer's panel while it's healthy. A healthy page is the strip, the quota cards and two one-line panels. Each panel opens by itself when something there needs a look.

For each account and limit window, including model-specific ones such as Claude's Fable-only weekly limit when your plan has one:

- how much is left, as a % with a meter
- a countdown to the reset and the reset time
- a **Low** warning (≤30% left) or **Nearly out** warning (≤10% left)
- a pace projection: how much will be left at the reset if you keep the current rate
- a tick on the meter marking how much of the window's time is left. If the bar ends left of the tick, you're using the quota faster than it refills.

When Anthropic's usage API reports no 5-hour window for a Claude account (`five_hour: null`), its card says "No 5-hour limit reported by Anthropic for this account" below the windows, so a missing 5-hour row isn't mistaken for a failed reading. No 5-hour row or percentage is made up for it.

Tap or click a window, or focus it and press Enter or Space, to show its exact numbers inline (left and used %, window length, share of the weekly limit, reset time, time left and reading age). Do the same again, or press Escape, to hide them. Each window opens on its own, and stays open through automatic and manual refreshes and the **Table** view, even when accounts change order. With a mouse or trackpad, hovering a window also previews the same numbers in a tooltip. The **Table** button shows everything as a table. The page updates every 2 minutes, and the tab title shows the tightest window per account.

Every request the page makes has a timeout: for quotas, 30 seconds per account in the last reading plus 15 seconds, and at least 60 seconds. The server reads accounts one after another, and each can take a 15-second profile lookup plus a 15-second usage request, so this covers a slow but healthy collection. Each timeout in a row doubles the next one, up to 10 minutes, so a collection bigger than the page expects still gets through. The other timeouts are 10 seconds for the version, 12 seconds for the computer panel and 100 seconds for the pipeline. A stalled server can't leave **Refresh** stuck: after a timeout the banner says so, the last cards stay on screen and the next refresh tries again. While the last quota load has failed, no card claims **● Live**. Each shows its reading's age (◷) instead, and the line under **Quotas** says ⚠ Couldn't refresh until a load succeeds.

The line under **Quotas** also shows which commit the server is running, linked on GitHub. It adds a text warning when that isn't the latest code:

- **⚠ Restart needed to run `<sha>`**: the checkout on disk has moved to a newer commit, but the process wasn't restarted. HEAD on disk is re-read at most once a minute.
- **⚠ Running `<sha>`, main is at `<sha>`**: `main` on GitHub has moved on. This is checked with a read-only `git ls-remote origin refs/heads/main` at most once every 15 minutes (15-second timeout). It never fetches, pulls or writes to the checkout. If the check fails, the last known value stays.

Without git or a `.git` directory, the version is unknown and the line shows nothing extra.

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

While the reading is healthy, the panel collapses to one line in its header, such as "✓ Nothing needs you · 2 jobs running · 3 queued · 4 stacked in umbrellas", and **Show details** opens the totals, the attention list and the repos. Healthy means that nothing needs your attention, the last update worked and the dashboard server answered, GitHub was available and returned everything, the pipeline isn't paused and is configured, and no active job is overdue for a heartbeat or launch. Any of these opens the panel. While the overview is loading or unavailable, the panel always shows its body, because that holds the only explanation. Once you open or close it, it stays that way through refreshes. The browser remembers that choice, separately from the Workspace computer's, when it can store it. An attention item or problem that wasn't on screen before still opens it, so a new item is never hidden. With the panel closed, its header names how many items need you and what's wrong. Following the glance tile's **Needs you** link, or loading the page at `#pipeline`, opens it too.

Unlike the process panel below, this panel publishes GitHub issue and PR titles and job summaries. Keep the dashboard tailnet-only.

## Workspace computer

On Linux, the **Workspace computer** panel reports the computer running the dashboard.

While every reading is healthy, the panel collapses to one line in its header, such as "✓ All OK · up 3d 4h · checked 20s ago", and **Show details** opens the readings below and the Computer diagnostics. It opens by itself whenever a reading is a warning or critical (the same conditions the At a glance tile counts), and when the reading is old or couldn't be updated. Once you open or close it, it stays that way through refreshes. The browser remembers that choice when it can store it. A condition that wasn't on screen before still opens it, so a new problem is never hidden; a reading that only moves, such as the battery going from 25% to 24%, doesn't count as new. The glance tile's **Workspace** link opens it too. With the panel closed, its header counts the open conditions instead of "All OK", and a note under it says when the reading is old or failed.

The readings are:

- Battery state of charge, charging state, and AC power.
- CPU temperature, plus GPU and SSD temperatures when their sensors are readable.
- Memory usage (using Linux's available-memory reading), swap usage, and uptime.
- The connected Wi-Fi network's name (SSID), or the wired connection's name, along with internet reachability and the HTTPS check's response time. Either Google's or Cloudflare's connectivity endpoint can confirm access; NetworkManager helps distinguish a disconnected link, limited connectivity, and a sign-in portal when both checks fail.
- Whether **CLIProxyAPI**, **ngrok-proxy-llm**, **T3 Code**, **Tailscale**, and the **network watchdog** are running, with automatic restart counts and service uptime. HTTP checks separately verify T3's local page and Tailscale route, CLIProxyAPI's `/healthz`, the retry proxy's backend-aware `/health`, and its public ngrok route. They don't send LLM requests or refresh credentials.
- An **Auto-update** row for the updater in [Keeping hp-laptop up to date](#keeping-hp-laptop-up-to-date), such as "Auto-update: last run 19:45 ✓ · next 20:00". A failed run shows a ⚠ warning with its exit status and the `journalctl --user -u ai-quota-dashboard-update` command that explains it; a stopped timer gets its own ⚠ warning. On a machine without the updater units the row just says "not installed". It comes from one read-only `systemctl --user show` of `ai-quota-dashboard-update.service` and its timer, published as `autoUpdate` in `/api/workspace`.

Below the panel, behind the same **Show details** button, **Computer diagnostics** adds:

- Linux CPU, memory, and I/O pressure (the share of time tasks were stalled over the last 10 seconds), plus the five largest processes by resident memory. The top-memory list shows executable names and PIDs, without arguments or environments. Memory warnings use available RAM and pressure: warning at ≤10% available, ≥10% partial stalls, or ≥1% full stalls; critical at ≤5% available or ≥10% full stalls.
- Internal SSD and T7 free space, actual T7 mount presence, read-only mount detection, and the last backup result, last known success, and next scheduled run. An autofs placeholder does not count as a mounted T7. A previous successful backup remains recorded if a later run fails; the last-success time is unknown if monitoring starts after a failure with no earlier record.
- Wi-Fi signal and link rate, active Tailscale peer connection types/counts, and a 30-minute history of HTTPS response times and unsuccessful internet checks. Link rate is not measured internet speed; the Tailscale view shows active connections, not a client-specific speed test.
- A recent-events timeline for observed service state changes/restarts, failed/recovered HTTP checks, internet/network changes, link-drop and OOM-kill counter increases, memory pressure, storage changes, backup results, auto-update runs that fail or recover and its timer stopping or starting, and agent pipeline changes (see below). An auto-update run in progress or an unreadable reading keeps the previous result, so neither records an event. Memory pressure counts as recovered only after 5 minutes of healthy readings, and the recovery is dated to the first of those readings: on a busy machine the level flips every 30 seconds to 2 minutes, and each flip would otherwise be its own incident. Warning readings during those 5 minutes continue the same incident, a rise to critical is recorded once, and unreadable readings neither end nor reopen it. The page still shows the current memory reading; only the history waits. Events are sampled, not a complete historical log; brief changes can fall between readings. Monitoring starts tracking on installation, with the current backup result seeded from systemd.
- An **Incidents** card, above Recent events, that pairs those events into episodes, so a phone shows at a glance whether a failure is still going on and how long it lasted. Active incidents come first ("Active since Tue 08:27 · 10m so far"), then the newest recovered ones ("08:20 → 08:35 · lasted 15m") and one-offs ("Observed once at …"), up to 10. Each row names its state in text, not just color. The episodes come only from recorded events, as `history.episodes` in `/api/workspace`; no extra probes run and no causes are inferred. The rules, in `incidentEpisodes()` in `workspace-history.mjs`:
  - A warning or critical event for a condition (internet, network, memory, a service's state, an HTTP check, a disk, auto-update, the auto-update or agent pump timer) opens an incident or joins the open one, which keeps the worst level. The next info event for the same condition (restored, recovered, running, storage available, active or enabled again) ends it.
  - `T7 backup failed` is ended only by `T7 backup completed successfully`; `T7 backup started` does not end it.
  - Service restarts, OOM kills, link drops, stopped or zombie workflow processes and pump failures are one-offs: they are shown as observed once and are never active.
  - Job events (the Agent pipeline panel covers them), pause/resume, routine backup starts and successes, and the restart and monitoring-started markers are not incidents.
  - When the computer restarted, or monitoring started over, during an incident, the row says so: the recovery may only have been seen once it was back.
  - A recovery whose failure is older than the kept history shows as recovered with "start not retained", never as active. A network change is not treated that way, because it may be a switch between two networks.
  - Readings are 30 seconds apart, so durations are approximate and brief changes can fall between readings.

### Agentctl & build-workflow

The diagnostics include a dedicated process/pipeline panel:

- Matches `agentctl` script entrypoints, processes working inside the build-workflow checkout, its T3 worktrees, or `~/.agent-workflow`, and their descendants. Unrelated agents or shell commands merely mentioning these names are excluded. An observed child remains tracked if reparented, using its PID and Linux start-time identity to avoid confusing a reused PID with the original process. That detached-child association lasts for the dashboard process lifetime.
- Shows PID/parent, role, process state, elapsed time, lifetime-average CPU percentage, individual RSS, and combined totals. Shared memory can be counted more than once in summed RSS. At most 100 process rows are displayed.
- Reads `agent-pump.service` and its timer. An inactive successful oneshot pump is **idle**, not a failure. It shows paused/quota-waiting state and the last tick without invoking `agentctl` or changing the pipeline.
- Shows today's plan launches against the configured `maxPlansPerDay` limit, remaining launches, and the next reset at midnight UTC (displayed in your local time). The count comes from the pump's `plansByDay` state, including launches that later fail; tasks and implementation runs don't use this cap. Missing or invalid readings show as unavailable.
- Reads selected job-record fields: ID, mode, status, timestamps, and whether launch/heartbeat deadlines are overdue. These are independent of OS process counts, because T3 workers can continue while no CLI command runs. Configured `staleMinutes` and `launchTimeoutMinutes` are respected (fallbacks: 60 and 15 minutes). The first 20 active and five recent completed records are shown; up to 500 most recently modified records are inspected, with partial readings marked.
- Adds stopped/zombie processes, pump/timer/pause changes, job status changes, and overdue/recovered heartbeats to the existing event timeline. Routine process starts and exits are not recorded: pipeline subprocesses come and go every minute, and the live list is already in this panel. A process must be stopped or zombie in two consecutive readings to be recorded, once per stretch, because headless browser children are often seen as zombies once just before they are reaped. Missing sources do not generate false events.

For script identification, the monitor briefly inspects a bounded local command-line prefix and working directory. Neither is returned by the API or saved in history. Prompts, arguments, job titles, notes, summaries, environments, and the workflow's `secrets` directory are not published. Monitoring does not launch, pause, kill, or modify jobs. Default paths and matching rules are in `agent-workflow.mjs`; the workflow state directory honors `AGENT_HOME`.

The server samples computer readings every 30 seconds even when no browser page is open. The page updates its computer panel every 30 seconds while visible. **Refresh** updates both computer readings and quotas. `/api/workspace` has its own 15-second cache (manual refresh: 5 seconds), independent from provider requests. Missing sensors or inaccessible services show as unavailable or unknown. If an update fails, the last reading stays visible with a warning.

The public ngrok HTTP check runs at most once every 15 minutes, including on manual refresh, to limit requests against its allowance. Its reading has a separate check timestamp; local health checks still run with each computer collection. Only the retry proxy's existing HTTPS ngrok tunnel is used, with a fixed `/health` path and redirects disabled. All HTTP probes have bounded timeouts and response sizes.

History is stored atomically in `.cache/workspace-history.json`: up to 100 events over seven days and 80 latency samples covering up to 30 minutes. Routine agent pipeline activity (info-level job status changes, recovered heartbeats and pause/resume) keeps only its newest 20 events and only fills room the other events leave, so it never pushes out a service, HTTP-check, network, memory, storage, backup or auto-update event, or an agent warning such as a failed pump, a failed, blocked or stalled job, or an overdue heartbeat. The pump timer starting again is kept like other events, since it ends the incident its stopping opened. A history file from an older build is trimmed to these rules on the next reading. It survives dashboard restarts. It contains selected status readings only, not raw journal logs, peer addresses, tokens, or credentials. A save failure is shown in the events panel.

Monitoring reads `/sys`, `/proc`, selected `systemctl show` properties, process memory, filesystem space, NetworkManager, and Tailscale status, and makes bounded HTTP(S) checks. It never controls services or changes power/network settings. The monitored units are listed in `workspace.mjs`, and health endpoints in `diagnostics.mjs`; unsupported operating systems still show quotas normally. No new packages or elevated privileges are needed.

Run `npm test` for quota parsing (Claude and Codex usage windows, plans, credential discovery, last-good fallback, the Host allow-list), collectors, HTTP payload validation, missing mounts, backup failures, event persistence, network quality, UI rendering/escaping, and caching checks. It also starts the HTTP server on a random port with fake collectors and checks the Host allow-list, every route, `force` pass-through, `Cache-Control`, 404s and 500s. `test/deploy.test.mjs` runs `deploy/update.sh` against a temporary git origin and clone with a fake `systemctl`, and `deploy/install.sh` against a temporary home.

`npm test` needs no install. The browser checks do: run `npm ci`, `npx playwright install chromium` once, then `npm run test:browser`. They live in `e2e/` and start the real server (`createDashboardServer()`) on a random port with fake collectors, so they read no credentials, providers, `agentctl` or `/proc`, and any request to anything but that server fails the test. Headless Chromium loads the page at phone (390×844, touch) and desktop (1280×800) width and checks that the page never scrolls sideways, that quota cards sit under At a glance, that window details open by tap, click, Enter or Space, close with Escape, keep focus and survive a refresh, that a failed workspace HTTP check opens the Workspace computer panel and names it in the glance tile, that Show/Hide details is remembered across reloads, that the glance tile's Workspace link opens a collapsed panel, that the Agent pipeline collapses to one summary line while nothing needs you, opens by keyboard, remembers Show/Hide across reloads, reopens for a new attention item and opens from the Needs you link (also when the URL already ends in `#pipeline`), that a closed Agent pipeline repo stays closed through a refresh, and that a failing quota collector shows "Couldn't refresh" while the other panels keep working. A failed run keeps a trace in `test-results/` (`npx playwright show-trace <file>`).

GitHub Actions (`.github/workflows/test.yml`) syntax-checks the modules and `deploy/` scripts, and runs `npm test` on Node 18, 20, 22 and 24 for every pull request into `main` or `agent/improvements`. A separate job installs Playwright and Chromium on Node 22 and runs `npm run test:browser`.

## Where the credentials come from

Accounts are discovered automatically. Claude/Codex accounts are grouped across sources; identical Antigravity OAuth logins saved in multiple T3 profiles are shown once.

| Provider | Sources |
|---|---|
| Claude | macOS Keychain item `Claude Code-credentials`, `~/.claude/.credentials.json`, CLIProxyAPI `claude-*.json` |
| ChatGPT / Codex | `~/.codex/auth.json`, CLIProxyAPI `codex-*.json` |
| Antigravity | T3 Code profiles at `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` (personal Google OAuth) |

CLIProxyAPI is optional. The dashboard only reads its auth folder (`~/.cli-proxy-api`, the one VibeProxy uses). When the proxy is running, it keeps those tokens fresh.

Usage numbers come from `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`. These are the same endpoints the Claude Code and Codex apps call. They're unofficial and may change.

Antigravity quotas are collected directly from Google's `v1internal:retrieveUserQuotaSummary` API on `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`, using the login T3 already saved. T3 does not need to be running. The collector reads both endpoints and keeps the higher usage for duplicate buckets; older accounts fall back to `fetchAvailableModels`. Cards show Gemini, Gemini Argon, and shared Claude/GPT buckets as reported, including their five-hour and weekly windows. Legacy model quotas without a reported cadence get no invented window length, billing cycle, or pace projection. Untouched buckets with a moving reset of now plus the window length get no countdown.

The collector renews Google's access token using the saved refresh token and retains it only in memory, until one minute before expiry. It never writes to T3's login files, launches AGY, or makes a model request. Account email is optional and comes from Google's user-info endpoint. Requests use fixed Google destinations, reject redirects, time out after 10 seconds each, and have a 30-second total budget per login. Missing/malformed quota responses retain the last successful reading with a stale warning. Enterprise, API-key, and gateway logins are not collected. These Google quota APIs are internal and may change.

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

## Keeping hp-laptop up to date

On hp-laptop, the dashboard runs from `~/ai-quota-dashboard` as the `ai-quota-dashboard.service` user unit. A user timer keeps it on the latest `main` (owner's decision [#17](https://github.com/omertekin2002/ai-quota-dashboard/issues/17)). Every 15 minutes, `ai-quota-dashboard-update.timer` runs `deploy/update.sh`, which:

1. takes a lock, so runs can't overlap; a run that finds the lock held exits without doing anything;
2. refuses, changing nothing and exiting non-zero (so `systemctl --user --failed` shows it), when the checkout isn't on `main`, has any tracked or untracked change, or has commits `origin/main` doesn't have. Ignored files such as `.cache/` don't count;
3. runs `git fetch origin main` with a 60-second timeout and no prompts, checks the checkout again (refusing if the branch, `HEAD` or any file changed during the fetch), then runs `git merge --ff-only`. It never resets, rebases, stashes, checks out or cleans anything;
4. restarts `ai-quota-dashboard.service` only if `HEAD` moved, and logs `old → new` short SHAs. If that restart fails, the next run retries it.

A bad commit on `main` therefore goes live within about 15 minutes of the merge.

The dashboard's Workspace computer panel shows the updater's last run, its result and the next run, and warns in text when a run failed or the timer stopped. Failures and recoveries also appear in Recent events. The dashboard only reads the units' state; it never starts, retries or enables the updater, and doesn't read its journal.

```sh
deploy/install.sh                                         # install or update (no sudo, safe to re-run)
systemctl --user list-timers ai-quota-dashboard-update.timer
systemctl --user start ai-quota-dashboard-update.service  # run once now
journalctl --user -u ai-quota-dashboard-update -n 20      # what it did
systemctl --user disable --now ai-quota-dashboard-update.timer  # pause it
```

`install.sh` copies `update.sh` to `~/.local/lib/ai-quota-dashboard-update/` and the two units to `~/.config/systemd/user/`, then enables the timer. It doesn't touch `ai-quota-dashboard.service` or Tailscale. The timer runs the installed copy, not the checkout's, so **re-run `deploy/install.sh` after changing anything in `deploy/`**. To remove it, disable the timer, delete those files, and run `systemctl --user daemon-reload`. To pin the dashboard to a commit, disable the timer and check that commit out by hand.

## Notes

- **Claude/Codex tokens are never refreshed or written back.** When a token has expired, the card shows the last successful reading, marked as old, until you run `claude` or `codex` once. Antigravity renews Google access tokens in memory as described above; a revoked Google login asks you to sign in again in T3 Code.
- The last successful reading is stored in `.cache/last-good.json` (written atomically, readable only by you). It holds usage numbers and emails only, no tokens. If it can't be saved, the error is logged and the live readings are still shown.
- If an endpoint's reply has a missing or unreadable usage figure, that window shows `—` and "Usage unknown" instead of a guessed percentage.
- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't `localhost`/`127.0.0.1` or listed in `ALLOWED_HOSTS`. That stops other websites from reading it through DNS rebinding.
- When a request fails, the reply is a generic `{"error":"internal error"}` with status 500; the real error is logged by the server only, so paths or tokens in error messages never reach the browser.
- Upstream calls are cached for 90 seconds, and the Claude plan lookup for 15 minutes. Pressing **Refresh** bypasses both, at most once every 15 seconds.
- `GET /healthz` returns `{"ok":true, "commit", "startedAt", "uptimeSec", …}` with the version fields above (short SHAs and flags, no paths, remote URLs or error text). It reads cached state only, so it stays cheap and never runs a collector. `GET /api/version` returns the version fields alone. Both obey the `Host` allow-list.
- On `SIGTERM` or `SIGINT` (e.g. `systemctl --user stop`), the server stops accepting connections, closes idle keep-alive ones, lets open requests finish and exits with code 0. If requests are still open after 4 seconds, it exits anyway. Workspace history is written to a temp file and renamed into place, so stopping mid-write never corrupts it.

| Env var | Default |
|---|---|
| `PORT` | `7417` |
| `CLIPROXY_AUTH_DIR` | `~/.cli-proxy-api` |
| `CODEX_HOME` | `~/.codex` |
| `T3_STATE_DIR` | `~/.t3/userdata` — dashboard override for discovering saved Antigravity logins |
| `ALLOWED_HOSTS` | (empty) — comma-separated extra hostnames to accept, e.g. your Tailscale MagicDNS name |
| `AGENTCTL` | `~/.local/bin/agentctl` — the build-workflow CLI the pipeline panel runs |
