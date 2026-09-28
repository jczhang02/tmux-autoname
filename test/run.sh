#!/usr/bin/env sh
# End-to-end tests for tmux-autoname, run against real isolated tmux
# servers. See docs/adr/0005-restore-deterministic-naming.md for the
# behaviour under test.
#
# shellcheck disable=SC2088  # literal leading "~" in expected values below
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
BIN="$REPO_DIR/bin/tmux-autoname"
PLUGIN="$REPO_DIR/tmux-autoname.tmux"

unset TMUX_AUTONAME_BIN 2>/dev/null || true

# Every test tmux server we spawn below picks its default-shell from $SHELL
# at server-start time. Force a plain POSIX sh regardless of the host's own
# login shell (e.g. an interactive zsh with a fancy multi-line prompt can
# swallow or misinterpret scripted send-keys), so the suite is deterministic.
export SHELL=/bin/sh

PASS=0
FAIL=0
FAIL_LIST=""

FAKE_DIR=$(mktemp -d)
SERVERS=""
SOCK=""

# shellcheck disable=SC2329  # invoked indirectly via trap
cleanup() {
  for s in $SERVERS; do
    tmux -L "$s" kill-server >/dev/null 2>&1 || true
  done
  rm -rf "$FAKE_DIR"
}
trap cleanup EXIT INT TERM

# Fake agents: each shell reads "title:<text>" lines from stdin and
# re-emits the title via OSC 0, or exits on "quit". pane_current_command
# only reports the launching name when the process itself (not a later
# shebang re-exec) is given that argv[0], so tests start these with
# `exec -a NAME sh NAME`.
cat >"$FAKE_DIR/plain" <<'SCRIPT'
#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    title:*) printf '\033]0;%s\007' "${line#title:}" ;;
    quit) exit 0 ;;
  esac
done
SCRIPT
chmod +x "$FAKE_DIR/plain"
ln -sf plain "$FAKE_DIR/pi-coding-agent"

TESTN=0
start_server() {
  # $1 = cwd for the initial window (default $HOME)
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  tmux -L "$SOCK" -f /dev/null new-session -d -s w -x 200 -y 50 -c "${1:-$HOME}"
}

stop_server() {
  tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
}

load_plugin() {
  tmux -L "$SOCK" run-shell "$PLUGIN"
}

t() {
  tmux -L "$SOCK" "$@"
}

start_fake() {
  # $1 = fake name to exec as, $2 = target pane (default: w)
  name=$1
  target=${2:-w}
  t send-keys -t "$target" "exec -a $name sh $FAKE_DIR/plain" Enter
  sleep 0.2
}

set_title() {
  # $1 = title text, $2 = target pane (default: w)
  target=${2:-w}
  t send-keys -t "$target" "title:$1" Enter
  sleep 0.2
}

sync_now() {
  # $1 = target pane or window (default: w)
  target=${1:-w}
  tmux -L "$SOCK" run-shell "'$BIN' sync -t $target" >/dev/null 2>&1 || true
}

wait_for() {
  # $1 = format, $2 = expected value, $3 = target (default: w)
  fmt=$1
  want=$2
  target=${3:-w}
  i=0
  while [ "$i" -lt 60 ]; do
    got=$(t display-message -p -t "$target" "$fmt" 2>/dev/null) || got=""
    [ "$got" = "$want" ] && return 0
    i=$((i + 1))
    sleep 0.05
  done
  return 1
}

assert_eq() {
  # $1 = description, $2 = format, $3 = expected, $4 = target (default: w)
  desc=$1
  fmt=$2
  want=$3
  target=${4:-w}
  if wait_for "$fmt" "$want" "$target"; then
    PASS=$((PASS + 1))
    printf 'ok - %s\n' "$desc"
  else
    got=$(t display-message -p -t "$target" "$fmt" 2>/dev/null) || got="<error>"
    FAIL=$((FAIL + 1))
    FAIL_LIST="${FAIL_LIST}
  - ${desc}"
    printf 'FAIL - %s (want %s, got %s)\n' "$desc" "$want" "$got"
  fi
}

pass() {
  # $1 = description
  PASS=$((PASS + 1))
  printf 'ok - %s\n' "$1"
}

fail() {
  # $1 = description
  FAIL=$((FAIL + 1))
  FAIL_LIST="${FAIL_LIST}
  - ${1}"
  printf 'FAIL - %s\n' "$1"
}

# --- Tests ------------------------------------------------------------------

test_session_container_workspace() {
  container_dir=$(mktemp -d)
  proj_dir="$container_dir/partjobs"
  mkdir -p "$proj_dir/patent-value-identification"
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  # session_path is fixed to the session's own initial cwd, so it must be
  # $proj_dir itself (matching the session name) for the session-container
  # rule to apply; the pane's own cwd is then moved into the subdirectory.
  tmux -L "$SOCK" -f /dev/null new-session -d -s partjobs -x 200 -y 50 -c "$proj_dir"
  load_plugin
  t send-keys -t partjobs:0 "cd $proj_dir/patent-value-identification" Enter
  start_fake zsh partjobs:0
  sync_now partjobs:0
  assert_eq "zsh in session-container workspace with area" \
    '#{window_name}' 'zsh:partjobs/patent-value-identification' 'partjobs:0'

  t new-window -t partjobs: -c "$proj_dir/patent-value-identification"
  start_fake codex partjobs:1
  sync_now partjobs:1
  assert_eq "codex in the same workspace/area" \
    '#{window_name}' 'codex:partjobs/patent-value-identification' 'partjobs:1'

  stop_server
  rm -rf "$container_dir"
}

test_session_no_git_no_container() {
  start_server
  load_plugin
  start_fake claude
  sync_now w
  assert_eq "claude in HOME session with no git repo" '#{window_name}' 'claude:w'
  stop_server
}

test_session_container_at_root_no_area() {
  container_dir=$(mktemp -d)
  proj_dir="$container_dir/tmux-autoname"
  mkdir -p "$proj_dir"
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  tmux -L "$SOCK" -f /dev/null new-session -d -s tmux-autoname -x 200 -y 50 -c "$proj_dir"
  load_plugin
  start_fake claude tmux-autoname:0
  sync_now tmux-autoname:0
  assert_eq "cwd at the session-container root has no area" \
    '#{window_name}' 'claude:tmux-autoname' 'tmux-autoname:0'
  stop_server
  rm -rf "$container_dir"
}

test_git_workspace_wins_over_session_name() {
  outer_dir=$(mktemp -d)
  session_dir="$outer_dir/foo"
  repo_dir="$outer_dir/bar"
  mkdir -p "$session_dir" "$repo_dir/src"
  (cd "$repo_dir" && git init -q && git commit -q --allow-empty -m init)
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  # Session "dev" started at .../foo, so session_path's basename ("foo")
  # does not match the session name ("dev"): the session-container rule
  # does not apply, and the git repo at .../bar wins instead.
  tmux -L "$SOCK" -f /dev/null new-session -d -s dev -x 200 -y 50 -c "$session_dir"
  load_plugin
  t new-window -t dev: -c "$repo_dir/src"
  start_fake nvim dev:1
  sync_now dev:1
  assert_eq "git repo workspace wins, with area from the git root" \
    '#{window_name}' 'nvim:bar/src' 'dev:1'
  stop_server
  rm -rf "$outer_dir"
}

test_git_worktree_area_depth_default() {
  repo_dir=$(mktemp -d)
  (cd "$repo_dir" && git init -q && git commit -q --allow-empty -m init)
  mkdir -p "$repo_dir/src/utils"
  start_server "$repo_dir/src/utils"
  load_plugin
  start_fake zsh
  sync_now w
  assert_eq "area truncated to its first segment by default (depth 1)" \
    '#{window_name}' "zsh:$(basename "$repo_dir")/src"
  stop_server
  rm -rf "$repo_dir"
}

test_area_depth_unlimited() {
  repo_dir=$(mktemp -d)
  (cd "$repo_dir" && git init -q && git commit -q --allow-empty -m init)
  mkdir -p "$repo_dir/src/utils"
  start_server "$repo_dir/src/utils"
  t set-option -g @tmux-autoname-area-depth 0
  load_plugin
  start_fake zsh
  sync_now w
  assert_eq "area kept in full when depth is 0 (unlimited)" \
    '#{window_name}' "zsh:$(basename "$repo_dir")/src/utils"
  stop_server
  rm -rf "$repo_dir"
}

test_ssh_workspace_from_title() {
  start_server
  load_plugin
  start_fake ssh
  set_title 'jc@gentoo-box: ~'
  sync_now w
  assert_eq "ssh workspace parsed from pane_title, no area" '#{window_name}' 'ssh:gentoo-box'
  stop_server
}

test_pi_coding_agent_activity_stripped() {
  start_server
  load_plugin
  start_fake pi-coding-agent
  sync_now w
  assert_eq "pi-coding-agent activity strips the -coding-agent suffix" \
    '#{window_name}' 'pi:w'
  stop_server
}

test_manual_rename_respected() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell "'$BIN' sync -t $win" >/dev/null 2>&1
  t rename-window -t w mymanualname
  tmux -L "$SOCK" run-shell "'$BIN' sync -t $win" >/dev/null 2>&1
  assert_eq "manual rename is not overwritten by sync" '#{window_name}' 'mymanualname'
  stop_server
}

test_auto_restores_after_manual() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  t rename-window -t w mymanualname
  tmux -L "$SOCK" run-shell "'$BIN' auto -t $win" >/dev/null 2>&1
  assert_eq "auto forgets manual rename and re-syncs" '#{window_name}' 'sh:w'
  stop_server
}

test_empty_rename_restores_auto() {
  start_server
  load_plugin
  t rename-window -t w mymanualname
  sleep 0.2
  t rename-window -t w ""
  assert_eq 'empty rename-window "" restores automatic naming' '#{window_name}' 'sh:w'
  stop_server
}

test_auto_subcommand() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  t rename-window -t w somethingelse
  tmux -L "$SOCK" run-shell "'$BIN' auto -t $win" >/dev/null 2>&1
  assert_eq "auto subcommand re-syncs the window" '#{window_name}' 'sh:w'
  stop_server
}

test_background_pane_does_not_hijack_window_name() {
  start_server
  load_plugin
  t split-window -t w -c "$HOME"
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  # pane2 is the newly split, active pane.
  start_fake claude "$pane1"
  start_fake zsh "$pane2"
  sync_now w
  assert_eq "window named from the active pane (zsh)" '#{window_name}' 'zsh:w'
  # Background pane (pane1, running claude) finishes a command and its own
  # sync fires - the WINDOW must still reflect the active pane (pane2),
  # not the background pane that triggered sync.
  tmux -L "$SOCK" run-shell "'$BIN' sync -t $pane1" >/dev/null 2>&1
  assert_eq "background pane's sync does not hijack the window name" \
    '#{window_name}' 'zsh:w'
  stop_server
}

test_after_kill_pane_syncs_remaining_window() {
  start_server
  load_plugin
  t split-window -t w -c "$HOME"
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  start_fake zsh "$pane1"
  start_fake nvim "$pane2"
  sync_now w
  assert_eq "window named from active pane (nvim) before kill" '#{window_name}' 'nvim:w'
  t kill-pane -t "$pane2"
  assert_eq "after-kill-pane syncs the remaining window from its new active pane" \
    '#{window_name}' 'zsh:w'
  stop_server
}

test_migration_window_state() {
  start_server

  manual_state=$(printf '{"mode":"manual","lastAppliedName":"old","manualName":"pinned"}' | base64 | tr -d '\n')
  automatic_state=$(printf '{"mode":"automatic","lastAppliedName":"old"}' | base64 | tr -d '\n')
  garbage_state='not-valid-base64!!!'

  t new-window -t w -c "$HOME" # win_manual (index 1)
  t new-window -t w -c "$HOME" # win_automatic (index 2)
  t new-window -t w -c "$HOME" # win_garbage (index 3)
  t new-window -t w -c "$HOME" # win_fresh_manual (index 4)
  t new-window -t w -c "$HOME" # win_fresh_auto (index 5)

  t set-option -t w:1 -w @tmux-autoname-state "$manual_state"
  t set-option -t w:1 -w @tmux-autoname-badge 'old-badge'
  t set-option -t w:1 -w automatic-rename off
  t rename-window -t w:1 mymanualname

  t set-option -t w:2 -w @tmux-autoname-state "$automatic_state"
  t set-option -t w:2 -w @tmux-autoname-badge 'old-badge'
  t set-option -t w:2 -w automatic-rename off

  t set-option -t w:3 -w @tmux-autoname-state "$garbage_state"

  t set-option -t w:4 -w automatic-rename off
  t rename-window -t w:4 usernamed

  load_plugin

  assert_eq "old manual state: rename is not overwritten" '#{window_name}' 'mymanualname' 'w:1'
  if [ -z "$(t show-option -t w:1 -wqv @tmux-autoname-state 2>/dev/null)" ]; then
    pass "old manual state: @tmux-autoname-state unset"
  else
    fail "old manual state: @tmux-autoname-state unset"
  fi
  if [ -z "$(t show-option -t w:1 -wqv @tmux-autoname-badge 2>/dev/null)" ]; then
    pass "old manual state: @tmux-autoname-badge unset"
  else
    fail "old manual state: @tmux-autoname-badge unset"
  fi

  assert_eq "old automatic state: new plugin takes over" '#{window_name}' 'sh:w' 'w:2'
  if [ -z "$(t show-option -t w:2 -wqv @tmux-autoname-state 2>/dev/null)" ]; then
    pass "old automatic state: @tmux-autoname-state unset"
  else
    fail "old automatic state: @tmux-autoname-state unset"
  fi

  applied3=$(t show-option -t w:3 -wqv @tmux-autoname-applied 2>/dev/null) || applied3=""
  curname3=$(t display-message -p -t w:3 '#{window_name}' 2>/dev/null) || curname3=""
  if [ -n "$applied3" ] && [ "$curname3" != "$applied3" ]; then
    pass "undecodable state is treated as manual"
  else
    fail "undecodable state is treated as manual"
  fi
  if [ -z "$(t show-option -t w:3 -wqv @tmux-autoname-state 2>/dev/null)" ]; then
    pass "undecodable state: @tmux-autoname-state unset"
  else
    fail "undecodable state: @tmux-autoname-state unset"
  fi

  assert_eq "fresh install: automatic-rename off with no old state is manual" \
    '#{window_name}' 'usernamed' 'w:4'

  assert_eq "fresh window with automatic-rename on stays automatic" '#{window_name}' 'sh:w' 'w:5'

  stop_server
}

test_loader_syncs_all_windows() {
  start_server
  t new-window -t w -c "$HOME"
  t new-window -t w -c "$HOME"
  load_plugin
  assert_eq "window 0 named on load" '#{window_name}' 'sh:w' 'w:0'
  assert_eq "window 1 named on load" '#{window_name}' 'sh:w' 'w:1'
  assert_eq "window 2 named on load" '#{window_name}' 'sh:w' 'w:2'
  stop_server
}

test_session_created_hook_registered() {
  start_server
  load_plugin
  if t show-hooks -g 2>/dev/null | grep -q 'session-created\[120\]'; then
    pass "session-created[120] hook registered"
  else
    fail "session-created[120] hook registered"
  fi
  t new-session -d -s second -c "$HOME"
  assert_eq "session-created hook names the new session's first window" \
    '#{window_name}' 'sh:second' 'second:0'
  t kill-session -t second
  stop_server
}

test_loader_ignores_inherited_bin_env_var() {
  start_server
  stale_bin="$FAKE_DIR/stale-tmux-autoname"
  cat >"$stale_bin" <<'SCRIPT'
#!/bin/sh
exit 1
SCRIPT
  chmod +x "$stale_bin"
  # A shell that inherited TMUX_AUTONAME_BIN from an old install (which used
  # to `export` it) must not pin the server to that stale binary: only a
  # tmux option set before the plugin loads is honoured.
  tmux -L "$SOCK" run-shell "TMUX_AUTONAME_BIN='$stale_bin' '$PLUGIN'"
  start_fake claude
  sync_now w
  assert_eq "inherited TMUX_AUTONAME_BIN is not used to resolve the binary" \
    '#{window_name}' 'claude:w'
  stop_server
}

test_loader_honours_bin_option_set_before_load() {
  start_server
  wrapper="$FAKE_DIR/custom-tmux-autoname"
  cat >"$wrapper" <<SCRIPT
#!/bin/sh
exec '$BIN' "\$@"
SCRIPT
  chmod +x "$wrapper"
  t set-option -g @tmux-autoname-bin "$wrapper"
  load_plugin
  start_fake claude
  sync_now w
  assert_eq "a @tmux-autoname-bin set before load is honoured" '#{window_name}' 'claude:w'
  if [ "$(t show-option -gqv @tmux-autoname-bin 2>/dev/null)" = "$wrapper" ]; then
    pass "the loader does not overwrite a user-set @tmux-autoname-bin"
  else
    fail "the loader does not overwrite a user-set @tmux-autoname-bin"
  fi
  stop_server
}

test_key_auto_binding() {
  start_server
  t set-option -g @tmux-autoname-key-auto 'M-a'
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  t rename-window -t w manualname
  # bind-key's command runs without a client attached to it in our test
  # harness, so invoke the bound binary command directly through run-shell
  # the same way the key would: this asserts the binding exists and its
  # command works, without needing a full attached-client drive.
  if t list-keys 2>/dev/null | grep -q "M-a"; then
    pass "key-auto binding is registered when @tmux-autoname-key-auto is set"
  else
    fail "key-auto binding is registered when @tmux-autoname-key-auto is set"
  fi
  tmux -L "$SOCK" run-shell "'$BIN' auto -t $win" >/dev/null 2>&1
  assert_eq "auto re-syncs after a manual rename" '#{window_name}' 'sh:w'
  stop_server
}

test_migration() {
  start_server
  t set-hook -g 'after-select-pane[120]' 'run-shell -b true'
  old_status='#I:#W#{?#{@tmux-autoname-badge}, #{@tmux-autoname-badge},}'
  t set-option -g window-status-format "$old_status"
  t set-option -g window-status-current-format "$old_status"
  t set-option -g @tmux-autoname-profile '{scope}/{task}'
  t set-option -g @tmux-autoname-server-state x
  t set-option -g @tmux-autoname-badge-style plain
  t set-option -g @tmux-autoname-install-badge on
  t set-option -g @tmux-autoname-agents 'claude codex pi'
  t set-option -g @tmux-autoname-max-width 32

  runtime_dir=${XDG_RUNTIME_DIR:-/tmp/tmux-autoname-$(id -u)}/tmux-autoname
  mkdir -p "$runtime_dir"
  # shellcheck disable=SC3038  # exec -a is not POSIX but is needed to fake
  # a process whose cmdline the migration matches against.
  (exec -a tmux-autoname-daemon-fake sleep 100) &
  fake_pid=$!
  echo "$fake_pid" >"$runtime_dir/test-$$.pid"

  load_plugin
  sleep 0.3

  if t show-hooks -g 2>/dev/null | grep -q 'after-select-pane\[120\]'; then
    fail "old after-select-pane[120] hook removed"
  else
    pass "old after-select-pane[120] hook removed"
  fi
  if t show-options -g window-status-format 2>/dev/null | grep -q '@tmux-autoname-badge'; then
    fail "badge fragment removed from window-status-format"
  else
    pass "badge fragment removed from window-status-format"
  fi
  if t show-options -g window-status-current-format 2>/dev/null | grep -q '@tmux-autoname-badge'; then
    fail "badge fragment removed from window-status-current-format"
  else
    pass "badge fragment removed from window-status-current-format"
  fi
  for old_opt in @tmux-autoname-profile @tmux-autoname-server-state \
    @tmux-autoname-badge-style @tmux-autoname-install-badge \
    @tmux-autoname-agents @tmux-autoname-max-width; do
    if [ -z "$(t show-option -gqv "$old_opt" 2>/dev/null)" ]; then
      pass "old $old_opt unset"
    else
      fail "old $old_opt unset"
    fi
  done
  if kill -0 "$fake_pid" 2>/dev/null; then
    fail "old daemon process stopped"
  else
    pass "old daemon process stopped"
  fi
  if [ -e "$runtime_dir/test-$$.pid" ]; then
    fail "old daemon pid file removed"
  else
    pass "old daemon pid file removed"
  fi

  stop_server
}

run_all() {
  test_session_no_git_no_container
  test_session_container_workspace
  test_session_container_at_root_no_area
  test_git_workspace_wins_over_session_name
  if command -v git >/dev/null 2>&1; then
    test_git_worktree_area_depth_default
    test_area_depth_unlimited
  fi
  test_ssh_workspace_from_title
  test_pi_coding_agent_activity_stripped
  test_manual_rename_respected
  test_auto_restores_after_manual
  test_empty_rename_restores_auto
  test_auto_subcommand
  test_background_pane_does_not_hijack_window_name
  test_after_kill_pane_syncs_remaining_window
  test_migration
  test_migration_window_state
  test_loader_syncs_all_windows
  test_session_created_hook_registered
  test_loader_ignores_inherited_bin_env_var
  test_loader_honours_bin_option_set_before_load
  test_key_auto_binding
}

run_all

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAIL_LIST"
  exit 1
fi
exit 0
