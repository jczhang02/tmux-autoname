#!/usr/bin/env sh
# tmux-autoname loader. See docs/adr/0005-restore-deterministic-naming.md.
set -eu

CURRENT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# The binary path always resolves to this checkout, unless the user set
# @tmux-autoname-bin themselves *before* the plugin loaded (e.g. in
# .tmux.conf, above the `run-shell .../tmux-autoname.tmux` line). We never
# read $TMUX_AUTONAME_BIN back from the process environment for this: a
# shell that inherited it from an old install (which used to `export` it)
# would otherwise pin every session to a stale binary. Once resolved, we
# leave @tmux-autoname-bin alone rather than overwriting a user's setting.
user_bin=$(tmux show-option -gqv @tmux-autoname-bin 2>/dev/null) || user_bin=""
if [ -n "$user_bin" ]; then
  AUTONAME_BIN=$user_bin
else
  AUTONAME_BIN="$CURRENT_DIR/bin/tmux-autoname"
fi

tmux set-option -gq @tmux-autoname-plugin-dir "$CURRENT_DIR"
tmux set-environment -g TMUX_AUTONAME_BIN "$AUTONAME_BIN"

# run-shell executes with the tmux server's own process environment, not
# the -g "set-environment" table, so hook commands below bake in the
# resolved binary path (single-quote escaped) rather than reading
# $TMUX_AUTONAME_BIN back out of the environment.
bin_q=$(printf '%s' "$AUTONAME_BIN" | sed "s/'/'\\\\''/g")

if [ -z "$(tmux show-option -gqv @tmux-autoname-area-depth)" ]; then
  tmux set-option -gq @tmux-autoname-area-depth 1
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

# Remove the appended badge fragment from window-status formats (left by
# the pre-0.6 daemon, and by 0.6's agent-title mirroring).
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

# Remove obsolete global options: pre-0.6 daemon options, and 0.6's
# agent-mirroring options that no longer exist.
for old_option in @tmux-autoname-profile @tmux-autoname-server-state \
  @tmux-autoname-badge-style @tmux-autoname-install-badge \
  @tmux-autoname-agents @tmux-autoname-max-width \
  @tmux-autoname-key-set @tmux-autoname-key-clear @tmux-autoname-key-pick; do
  tmux set-option -gu "$old_option" 2>/dev/null || true
done

# Migrate per-window state left by the pre-0.6 version: @tmux-autoname-state
# is base64 JSON like {"mode":"manual"|"automatic",...} and
# @tmux-autoname-badge is the old badge text. A window with mode "manual"
# must never be renamed by sync, so it is marked manual with a sentinel that
# can never equal a real window name (an old daemon-driven install also
# leaves window-local automatic-rename off, which the heuristic below would
# otherwise also call manual - harmless, but the explicit state always wins
# because it is applied first). A window with mode "automatic" is left for
# the new plugin to take over from scratch. If the state can't be decoded,
# treat it as manual: never overwrite a name when uncertain.
#
# Also drop 0.6's per-window @tmux-autoname-pin/-title/-workspace/-label/
# -prefill/-seen options: none of them exist in this version.
MIGRATION_SENTINEL=$(printf '\001tmux-autoname:migrated-manual\001')
for win in $(tmux list-windows -a -F '#{window_id}' 2>/dev/null); do
  old_state=$(tmux show-option -t "$win" -wqv @tmux-autoname-state 2>/dev/null) || old_state=""
  if [ -n "$old_state" ]; then
    decoded=""
    if out=$(printf '%s' "$old_state" | base64 -d 2>/dev/null); then
      decoded=$out
    elif out=$(printf '%s' "$old_state" | base64 -D 2>/dev/null); then
      decoded=$out
    fi
    case "$decoded" in
      *'"mode":"automatic"'*) : ;; # let the new plugin take over
      *) tmux set-option -t "$win" -wq @tmux-autoname-applied "$MIGRATION_SENTINEL" ;;
    esac
    tmux set-option -t "$win" -wu @tmux-autoname-state 2>/dev/null || true
    tmux set-option -t "$win" -wu @tmux-autoname-badge 2>/dev/null || true
  else
    applied=$(tmux show-option -t "$win" -wqv @tmux-autoname-applied 2>/dev/null) || applied=""
    if [ -z "$applied" ]; then
      ar=$(tmux show-options -w -t "$win" automatic-rename 2>/dev/null) || ar=""
      case "$ar" in
        *" off"*) tmux set-option -t "$win" -wq @tmux-autoname-applied "$MIGRATION_SENTINEL" ;;
      esac
    fi
  fi
  for old_wopt in @tmux-autoname-pin @tmux-autoname-title @tmux-autoname-workspace \
    @tmux-autoname-label @tmux-autoname-prefill @tmux-autoname-seen; do
    tmux set-option -t "$win" -wu "$old_wopt" 2>/dev/null || true
  done
done

# --- Hooks ------------------------------------------------------------------
sync_window_cmd="run-shell -b \"'${bin_q}' sync -t '#{window_id}'\""
tmux set-hook -g 'after-new-window[120]' "$sync_window_cmd"
tmux set-hook -g 'after-select-window[120]' "$sync_window_cmd"
tmux set-hook -g 'window-pane-changed[120]' "$sync_window_cmd"
tmux set-hook -g 'after-split-window[120]' "$sync_window_cmd"
tmux set-hook -g 'client-attached[120]' "$sync_window_cmd"
# The plugin loads before the first session exists (TPM/run-shell fires at
# tmux server start), so the loader's own final sync below can't reach that
# session's first window yet. session-created covers it.
tmux set-hook -g 'session-created[120]' "$sync_window_cmd"

# after-kill-pane's own pane is already gone by the time it fires; using
# #{window_id} (as for the other hooks above) syncs the window that
# remains, from whichever pane is now active in it, rather than anything
# tied to the killed pane.
tmux set-hook -g 'after-kill-pane[120]' "$sync_window_cmd"

# An empty `rename-window ""` restores automatic naming; any other rename
# is a Manual Name that sync will not overwrite until `auto` is run.
auto_window_cmd="run-shell -b \\\"'${bin_q}' auto -t '#{window_id}'\\\""
tmux set-hook -g 'after-rename-window[120]' \
  "if-shell -F '#{==:#{window_name},}' \"${auto_window_cmd}\""

# --- Optional key binding ----------------------------------------------------
#
# Off by default; bound only when the option is set.
key_auto=$(tmux show-option -gqv @tmux-autoname-key-auto)
if [ -n "$key_auto" ]; then
  tmux bind-key "$key_auto" \
    run-shell -b "'${bin_q}' auto -t #{window_id}"
fi

# Sync every window on every session, not just the current one: the loader
# runs once at tmux server start, before session-created has had a chance
# to fire for anything, so this is what actually names the very first
# window (and any other windows already restored by, e.g., tmux-resurrect).
#
# run-shell format-expands its own command argument before handing it to
# the shell (the same mechanism the hook commands above rely on for
# #{window_id}/#{pane_id}), so the nested `list-windows -F '#{window_id}'`
# has to be double-hashed (##{window_id}) - otherwise tmux replaces it up
# front with a single literal window id (the current window's), and every
# loop iteration below ends up syncing the same window.
sync_all_cmd="for w in \$(tmux list-windows -a -F '##{window_id}'); do '${bin_q}' sync -t \"\$w\" >/dev/null 2>&1 || true; done"
tmux run-shell -b "$sync_all_cmd"
