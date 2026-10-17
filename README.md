# ai-quota-dashboard

A local dashboard showing how much of your **5-hour** and **weekly** limits is left on Claude and ChatGPT (Codex) subscriptions.

No dependencies, no build step. Needs Node 18+.

```sh
npm start            # http://localhost:7417
npm run json         # print current quotas as JSON and exit
```

## What it shows

For each account and limit window:

- how much is left, as a % with a meter
- a countdown to the reset and the reset time
- a **Low** warning (≤30% left) or **Nearly out** warning (≤10% left)
- a pace projection: how much will be left at the reset if you keep the current rate
- a tick on the meter marking how much of the window's time is left. If the bar ends left of the tick, you're using the quota faster than it refills.

Hover a window for exact numbers. The **Table** button shows everything as a table. The page updates every 2 minutes, and the tab title shows the tightest window per account.

## Where the credentials come from

Accounts are discovered automatically. When the same account appears in several places, it's shown once.

| Provider | Sources |
|---|---|
| Claude | macOS Keychain item `Claude Code-credentials`, `~/.claude/.credentials.json`, CLIProxyAPI `claude-*.json` |
| ChatGPT / Codex | `~/.codex/auth.json`, CLIProxyAPI `codex-*.json` |

CLIProxyAPI is optional. The dashboard only reads its auth folder (`~/.cli-proxy-api`, the one VibeProxy uses). When the proxy is running, it keeps those tokens fresh.

Usage numbers come from `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`. These are the same endpoints the Claude Code and Codex apps call. They're unofficial and may change.

## Notes

- **Tokens are never refreshed or written back.** Both providers' refresh tokens are one-time-use, so refreshing them here would log the CLIs out. When a token has expired, the card shows the last successful reading, marked as old, until you run `claude` or `codex` once.
- The last successful reading is stored in `.cache/last-good.json`. It holds usage numbers and emails only, no tokens.
- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't `localhost`/`127.0.0.1`. That stops other websites from reading it through DNS rebinding.
- Upstream calls are cached for 90 seconds. Pressing **Refresh** bypasses the cache, at most once every 15 seconds.

| Env var | Default |
|---|---|
| `PORT` | `7417` |
| `CLIPROXY_AUTH_DIR` | `~/.cli-proxy-api` |
| `CODEX_HOME` | `~/.codex` |
