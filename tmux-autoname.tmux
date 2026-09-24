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
# ADR 0003: the default display format is Workspace/Task, with no Activity
# and no Area. Seed the new default when unset, and migrate a value still
# sitting at the old unedited default (never seed over a genuine user
# customization, even one that happens to contain {activity}: the daemon
# itself diagnoses and falls back for that case).
current_profile=$(tmux show-option -gqv @tmux-autoname-profile)
if [ -z "$current_profile" ]; then
  tmux set-option -gq @tmux-autoname-profile '{scope}/{task}'
elif [ "$current_profile" = '{activity}:{scope}/{task}' ]; then
  tmux set-option -gq @tmux-autoname-profile '{scope}/{task}'
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

# Optional, off-by-default key bindings: only bound when the user sets the
# option explicitly, mirroring the opt-in pattern above. Each runs the
# command for the current window and reports the result via display-message.
key_refresh=$(tmux show-option -gqv @tmux-autoname-key-refresh)
if [ -n "$key_refresh" ]; then
  refresh_action="out=\$(\"\$TMUX_AUTONAME_BIN\" refresh --window #{window_id} 2>&1); tmux display-message \"tmux-autoname refresh: \$out\""
  tmux bind-key "$key_refresh" run-shell -b "$refresh_action"
fi
key_auto=$(tmux show-option -gqv @tmux-autoname-key-auto)
if [ -n "$key_auto" ]; then
  auto_action="out=\$(\"\$TMUX_AUTONAME_BIN\" auto --window #{window_id} 2>&1); tmux display-message \"tmux-autoname auto: \${out:-restored}\""
  tmux bind-key "$key_auto" run-shell -b "$auto_action"
fi
key_new=$(tmux show-option -gqv @tmux-autoname-key-new)
if [ -n "$key_new" ]; then
  new_action="out=\$(\"\$TMUX_AUTONAME_BIN\" new --window #{window_id} 2>&1); tmux display-message \"tmux-autoname new: \$out\""
  tmux bind-key "$key_new" run-shell -b "$new_action"
fi

emit_hook="\"\$TMUX_AUTONAME_BIN\" emit --source tmux --kind window_changed --window #{window_id} >/dev/null 2>&1"
rename_hook="\"\$TMUX_AUTONAME_BIN\" emit --source tmux --kind manual_name_changed --window #{window_id} --manual-name #{q:window_name} >/dev/null 2>&1"

tmux set-hook -g 'after-new-window[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-select-window[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-select-pane[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'client-attached[120]' "run-shell -b '$emit_hook'"
tmux set-hook -g 'after-rename-window[120]' "run-shell -b '$rename_hook'"

tmux run-shell -b "\"\$TMUX_AUTONAME_BIN\" daemon >/dev/null 2>&1"
