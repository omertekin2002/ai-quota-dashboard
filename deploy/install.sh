#!/usr/bin/env bash
# Installs the ai-quota-dashboard update timer for the current user (no sudo).
# Idempotent: re-run it after changing deploy/ to update the installed copies.
# Writes only ~/.local/lib/ai-quota-dashboard-update/ and
# ~/.config/systemd/user/ai-quota-dashboard-update.{service,timer}.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lib_dir=$HOME/.local/lib/ai-quota-dashboard-update
unit_dir=$HOME/.config/systemd/user

install -d "$lib_dir" "$unit_dir"
install -m 755 "$here/update.sh" "$lib_dir/update.sh"
install -m 644 "$here/ai-quota-dashboard-update.service" "$here/ai-quota-dashboard-update.timer" "$unit_dir/"

systemctl --user daemon-reload
systemctl --user enable --now ai-quota-dashboard-update.timer
echo "Installed. Check it with: systemctl --user list-timers ai-quota-dashboard-update.timer"
