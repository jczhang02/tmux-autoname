#!/usr/bin/env bash
set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="${TMUX_AUTONAME_BUN:-bun}"

if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
  tmux display-message "tmux-autoname: bun not found"
  exit 0
fi

if ! command -v flock >/dev/null 2>&1; then
  tmux display-message "tmux-autoname: flock not found"
  exit 0
fi

tmux set-option -gq @autoname_plugin_dir "$CURRENT_DIR"
tmux bind-key N run-shell -b "$BUN_BIN '$CURRENT_DIR/bin/tmux-autoname.ts' reset-current '#{window_id}'"
tmux run-shell -b "$BUN_BIN '$CURRENT_DIR/bin/tmux-autoname.ts' start"
