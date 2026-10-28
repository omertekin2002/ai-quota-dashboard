#!/usr/bin/env bash
# Fast-forwards the dashboard checkout from origin/main and restarts the
# dashboard service only when HEAD moved. It refuses (non-zero exit, nothing
# changed) on any local change, on a branch other than main, or when local main
# has commits origin/main doesn't. It never resets, rebases, stashes, checks
# out or cleans. Run by ai-quota-dashboard-update.service; see README.
set -euo pipefail

repo=${AQD_UPDATE_REPO:-$HOME/ai-quota-dashboard}
remote=${AQD_UPDATE_REMOTE:-origin}
branch=${AQD_UPDATE_BRANCH:-main}
service=${AQD_UPDATE_SERVICE:-ai-quota-dashboard.service}
systemctl_cmd=${AQD_UPDATE_SYSTEMCTL:-systemctl}
lock=${AQD_UPDATE_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/ai-quota-dashboard-update.lock}
fetch_timeout=${AQD_UPDATE_FETCH_TIMEOUT:-60}

log() { printf 'ai-quota-dashboard-update: %s\n' "$*"; }
refuse() { printf 'ai-quota-dashboard-update: refusing: %s\n' "$*" >&2; exit 1; }

# Never prompt: no terminal, no askpass helper, ssh in batch mode. Configured
# credential helpers (e.g. gh) still work. GIT_OPTIONAL_LOCKS=0 stops
# `git status` from rewriting the index.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=false
export GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_OPTIONAL_LOCKS=0
unset SSH_ASKPASS
exec </dev/null

exec 9>"$lock"
if ! flock -n 9; then
  log "another update holds $lock; skipping this run"
  exit 0
fi

g() { git -C "$repo" "$@"; }

[[ -d $repo ]] || refuse "$repo does not exist"
current=$(g symbolic-ref --quiet --short HEAD) || refuse "$repo is not on a branch (detached HEAD)"
[[ $current == "$branch" ]] || refuse "$repo is on branch '$current', not '$branch'"
changes=$(g status --porcelain --untracked-files=all)
[[ -z $changes ]] || refuse "$repo has local changes:"$'\n'"$changes"

old=$(g rev-parse --verify HEAD)
timeout --kill-after=5 "$fetch_timeout" git -C "$repo" fetch --quiet --no-tags "$remote" "$branch" \
  || refuse "git fetch $remote $branch failed or timed out after ${fetch_timeout}s"
target=$(g rev-parse --verify 'FETCH_HEAD^{commit}')

# Set between the fast-forward and a successful restart, so a failed restart
# is retried by the next run even though HEAD no longer moves.
pending=$lock.restart-pending

if [[ $old != "$target" ]]; then
  g merge-base --is-ancestor "$old" "$target" \
    || refuse "local $branch (${old:0:7}) has commits $remote/$branch (${target:0:7}) doesn't; can't fast-forward"
  g merge --ff-only --quiet "$target"
  : >"$pending"
  log "fast-forwarded ${old:0:7} → $(g rev-parse --short HEAD)"
elif [[ -e $pending ]]; then
  log "already at $remote/$branch (${old:0:7}), but the last restart failed; retrying it"
else
  log "already at $remote/$branch (${old:0:7}); nothing to do"
  exit 0
fi

"$systemctl_cmd" --user restart "$service"
rm -f "$pending"
log "restarted $service at $(g rev-parse --short HEAD)"
