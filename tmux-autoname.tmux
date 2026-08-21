#!/usr/bin/env sh
set -eu

CURRENT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
AUTONAME_BIN=${TMUX_AUTONAME_BIN:-$CURRENT_DIR/bin/tmux-autoname}

tmux set-option -gq @tmux-autoname-plugin-dir "$CURRENT_DIR"
tmux set-option -gq @tmux-autoname-bin "$AUTONAME_BIN"
tmux set-environment -g TMUX_AUTONAME_BIN "$AUTONAME_BIN"
tmux set-option -wgq automatic-rename off

if [ -z "$(tmux show-option -gqv @tmux-autoname-badge-style)" ]; then
  tmux set-option -gq @tmux-autoname-badge-style plain
fi
if [ -z "$(tmux show-option -gqv @tmux-autoname-install-badge)" ]; then
  tmux set-option -gq @tmux-autoname-install-badge on
fi
if [ -z "$(tmux show-option -gqv @tmux-autoname-profile)" ]; then
  tmux set-option -gq @tmux-autoname-profile '{activity}:{scope}/{task}'
fi

if [ "$(tmux show-option -gqv @tmux-autoname-install-badge)" != off ]; then
  badge_fragment='#{?#{@tmux-autoname-badge}, #{@tmux-autoname-badge},}'
  for option in window-status-format window-status-current-format; do
    value=$(tmux show-option -gv "$option")
    case $value in
      *'#{@tmux-autoname-badge}'*) ;;
      *) tmux set-option -gq "$option" "${value}${badge_fragment}" ;;
    esac
  done
fi

emit_hook="\"\$TMUX_AUTONAME_BIN\" emit --source tmux --kind window_changed --window #{window_id} >/dev/null 2>&1"
rename_hook="\"\$TMUX_AUTONAME_BIN\" emit --source tmux --kind manual_name_changed --window #{window_id} >/dev/null 2>&1"

tmux set-hook -g 'after-new-window[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-select-window[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-select-pane[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'client-attached[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-rename-window[120]' "run-shell -b '$rename_hook'"

tmux run-shell -b "\"\$TMUX_AUTONAME_BIN\" daemon >/dev/null 2>&1"
