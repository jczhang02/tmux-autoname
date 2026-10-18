#!/usr/bin/env sh
# tmux-autoname loader. See docs/adr/0006-rewrite-with-icons.md.
set -eu

CURRENT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
AUTONAME_BIN="$CURRENT_DIR/bin/tmux-autoname"

# For the zsh integration. run-shell uses the server's own process
# environment, not this table, so the hooks below bake in the path instead.
tmux set-environment -g TMUX_AUTONAME_BIN "$AUTONAME_BIN"

# The bin path as a run-shell command word: quoted for sh, then "#" doubled
# because run-shell format-expands its command.
bin_rs=$(printf '%s' "$AUTONAME_BIN" | sed -e "s/'/'\\\\''/g" -e 's/#/##/g')
bin_rs="'$bin_rs'"
# The same inside a tmux double-quoted string: \, " and $ escaped.
dq() { printf '%s' "$1" | sed -e 's/[\\"$]/\\&/g'; }
bin_dq=$(dq "$bin_rs")

# --- Hooks ------------------------------------------------------------------
sync_window_cmd="run-shell -b \"${bin_dq} sync -t '#{window_id}'\""
tmux set-hook -g 'after-new-window[120]' "$sync_window_cmd"
tmux set-hook -g 'after-select-window[120]' "$sync_window_cmd"
tmux set-hook -g 'window-pane-changed[120]' "$sync_window_cmd"
tmux set-hook -g 'after-split-window[120]' "$sync_window_cmd"
tmux set-hook -g 'client-attached[120]' "$sync_window_cmd"
# The plugin loads before the first session exists, so the final sync below
# can't reach that session's first window; session-created covers it.
tmux set-hook -g 'session-created[120]' "$sync_window_cmd"
# The killed pane is gone when this fires; #{window_id} syncs the window
# that remains, from its now active pane.
tmux set-hook -g 'after-kill-pane[120]' "$sync_window_cmd"
# break-pane has no after- hook; window-linked covers it (and fires again,
# harmlessly, for new-window).
tmux set-hook -g 'window-linked[120]' "$sync_window_cmd"

# The Manual Mark, unless the user set @tmux-autoname-manual-mark (an empty
# value shows no mark).
[ -n "$(tmux show-option -gq @tmux-autoname-manual-mark)" ] ||
  tmux set-option -gq @tmux-autoname-manual-mark '󰏫'

# `rename-window ""` restores automatic naming; any other rename is a
# Manual Name that sync keeps until `auto` is run. That rename sets the
# Manual Mark at once, in tmux alone. This also runs for sync's own rename,
# before sync writes @tmux-autoname-applied, so sync clears the mark then.
# if-shell parses its command again when it runs: a second quoting layer.
auto_window_cmd="run-shell -b \\\"$(dq "$bin_dq") auto -t '#{window_id}'\\\""
manual_cond="#{&&:#{@tmux-autoname-applied},#{!=:#{window_name},#{@tmux-autoname-applied}}}"
# No -t: a target in a hook's if-shell branch is not format-expanded, and
# the hook's own target is already the renamed window.
mark_window_cmd="set-option -wqF @tmux-autoname-manual '#{?${manual_cond},#{@tmux-autoname-manual-mark},}'"
tmux set-hook -g 'after-rename-window[120]' \
  "if-shell -F '#{==:#{window_name},}' \"${auto_window_cmd}\" \"${mark_window_cmd}\""

# --- Optional key binding ----------------------------------------------------
key_auto=$(tmux show-option -gqv @tmux-autoname-key-auto)
if [ -n "$key_auto" ]; then
  tmux bind-key "$key_auto" run-shell -b "${bin_rs} auto -t #{window_id}"
fi

# Sync every window of every session (e.g. ones restored by tmux-resurrect).
# run-shell format-expands its command first, so the nested
# list-windows format is double-hashed; a single # would expand to the
# current window's id up front.
sync_all_cmd="for w in \$(tmux list-windows -a -F '##{window_id}'); do ${bin_rs} sync -t \"\$w\" >/dev/null 2>&1 || true; done"
tmux run-shell -b "$sync_all_cmd"
