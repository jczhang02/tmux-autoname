#!/usr/bin/env sh
# tmux-autoname loader. See docs/adr/0004-mirror-agent-titles.md.
set -eu

CURRENT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
AUTONAME_BIN=${TMUX_AUTONAME_BIN:-$CURRENT_DIR/bin/tmux-autoname}

tmux set-option -gq @tmux-autoname-plugin-dir "$CURRENT_DIR"
tmux set-option -gq @tmux-autoname-bin "$AUTONAME_BIN"
tmux set-environment -g TMUX_AUTONAME_BIN "$AUTONAME_BIN"

# run-shell executes with the tmux server's own process environment, not
# the -g "set-environment" table, so hook commands below bake in the
# resolved binary path (single-quote escaped) rather than reading
# $TMUX_AUTONAME_BIN back out of the environment.
bin_q=$(printf '%s' "$AUTONAME_BIN" | sed "s/'/'\\\\''/g")

if [ -z "$(tmux show-option -gqv @tmux-autoname-agents)" ]; then
  tmux set-option -gq @tmux-autoname-agents 'claude codex pi'
fi
if [ -z "$(tmux show-option -gqv @tmux-autoname-max-width)" ]; then
  tmux set-option -gq @tmux-autoname-max-width 32
fi

# --- Migration from the pre-0.6 TypeScript/daemon version -----------------
#
# Stop any old resident daemon (pid files under
# ${XDG_RUNTIME_DIR:-/tmp/tmux-autoname-$(id -u)}/tmux-autoname/*.pid, whose
# process cmdline contains "tmux-autoname daemon").
old_runtime_dir=${XDG_RUNTIME_DIR:-/tmp/tmux-autoname-$(id -u)}/tmux-autoname
if [ -d "$old_runtime_dir" ]; then
  for pid_file in "$old_runtime_dir"/*.pid; do
    [ -f "$pid_file" ] || continue
    old_pid=$(cat "$pid_file" 2>/dev/null) || old_pid=""
    if [ -n "$old_pid" ] && [ -r "/proc/$old_pid/cmdline" ]; then
      case "$(tr '\0' ' ' <"/proc/$old_pid/cmdline" 2>/dev/null)" in
        *tmux-autoname*daemon*) kill "$old_pid" 2>/dev/null || true ;;
      esac
    fi
    rm -f "$pid_file"
  done
fi

# The [120] hooks below overwrite the old daemon-driven ones at the same
# index for after-new-window, after-select-window, client-attached, and
# after-rename-window. after-select-pane[120] has no new use, so drop it.
tmux set-hook -gu 'after-select-pane[120]' 2>/dev/null || true

# Remove the appended badge fragment from window-status formats.
badge_fragment='#{?#{@tmux-autoname-badge}, #{@tmux-autoname-badge},}'
for status_option in window-status-format window-status-current-format; do
  current_value=$(tmux show-option -gv "$status_option" 2>/dev/null) || current_value=""
  case "$current_value" in
    *"$badge_fragment"*)
      trimmed=${current_value%"$badge_fragment"}
      tmux set-option -gq "$status_option" "$trimmed"
      ;;
  esac
done

# Remove obsolete global options. Per-window @tmux-autoname-state and
# @tmux-autoname-badge are left in place: they die with their windows and
# are simply never read by the new implementation.
for old_option in @tmux-autoname-profile @tmux-autoname-server-state \
  @tmux-autoname-badge-style @tmux-autoname-install-badge; do
  tmux set-option -gu "$old_option" 2>/dev/null || true
done

# --- Hooks ------------------------------------------------------------------
#
# pane-title-changed filters in tmux itself: the glyph-stripped title is
# compared against a per-pane marker with if-shell -F (no fork) and
# run-shell only spawns when it actually changed.
glyph_fmt='#{s/^[^A-Za-z0-9 ][^A-Za-z0-9 ]?[^A-Za-z0-9 ]?[^A-Za-z0-9 ]? //:pane_title}'
sync_pane_cmd="run-shell -b \\\"'${bin_q}' sync -t '#{pane_id}'\\\""
tmux set-hook -g 'pane-title-changed[120]' \
  "if-shell -F '#{!=:${glyph_fmt},#{@tmux-autoname-seen}}' \"${sync_pane_cmd}\""

sync_window_cmd="run-shell -b \"'${bin_q}' sync -t '#{window_id}'\""
tmux set-hook -g 'after-new-window[120]' "$sync_window_cmd"
tmux set-hook -g 'after-select-window[120]' "$sync_window_cmd"
tmux set-hook -g 'window-pane-changed[120]' "$sync_window_cmd"
tmux set-hook -g 'after-split-window[120]' "$sync_window_cmd"
tmux set-hook -g 'client-attached[120]' "$sync_window_cmd"

# An empty `rename-window ""` restores automatic naming. Nested one level
# deeper than the plain sync hooks above (inside if-shell's command
# argument), so the inner quotes need an extra level of escaping.
auto_window_cmd="run-shell -b \\\"'${bin_q}' auto -t '#{window_id}'\\\""
tmux set-hook -g 'after-rename-window[120]' \
  "if-shell -F '#{==:#{window_name},}' \"${auto_window_cmd}\""

# --- Optional key bindings ---------------------------------------------------
#
# Off by default; bound only when the option is set, mirroring the opt-in
# pattern for badges in the old version.
key_set=$(tmux show-option -gqv @tmux-autoname-key-set)
if [ -n "$key_set" ]; then
  tmux bind-key "$key_set" \
    command-prompt -I "#{@tmux-autoname-label}" -p "tmux-autoname set:" \
    "run-shell -b \"'${bin_q}' set -t #{window_id} '%%'\""
fi
key_clear=$(tmux show-option -gqv @tmux-autoname-key-clear)
if [ -n "$key_clear" ]; then
  tmux bind-key "$key_clear" \
    run-shell -b "'${bin_q}' clear -t #{window_id}"
fi
key_pick=$(tmux show-option -gqv @tmux-autoname-key-pick)
if [ -n "$key_pick" ]; then
  tmux bind-key "$key_pick" \
    choose-tree -Zw -F "#{window_index}: #{@tmux-autoname-label}"
fi

tmux run-shell -b "'${bin_q}' sync >/dev/null 2>&1 || true"
