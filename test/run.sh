#!/usr/bin/env sh
# End-to-end tests for tmux-autoname, run against real isolated tmux
# servers. See docs/adr/0004-mirror-agent-titles.md for the behaviour
# under test.
#
# shellcheck disable=SC2088  # literal leading "~" in expected values below
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
BIN="$REPO_DIR/bin/tmux-autoname"
PLUGIN="$REPO_DIR/tmux-autoname.tmux"

unset TMUX_AUTONAME_BIN 2>/dev/null || true

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

# Fake agents: each prints an initial (placeholder) title, then reads
# "title:<text>" lines from its stdin and re-emits the title via OSC 0,
# or exits on "quit". pane_current_command only reports the launching
# name when the process itself (not a later shebang re-exec) is given
# that argv[0], so tests start these with `exec -a NAME sh NAME`.
cat >"$FAKE_DIR/claude" <<'SCRIPT'
#!/bin/sh
printf '\033]0;%s\007' "✳ Claude Code"
while IFS= read -r line; do
  case "$line" in
    title:*) printf '\033]0;%s\007' "${line#title:}" ;;
    quit) exit 0 ;;
  esac
done
SCRIPT

cat >"$FAKE_DIR/codex" <<'SCRIPT'
#!/bin/sh
printf '\033]0;%s\007' "codex"
while IFS= read -r line; do
  case "$line" in
    title:*) printf '\033]0;%s\007' "${line#title:}" ;;
    quit) exit 0 ;;
  esac
done
SCRIPT

cat >"$FAKE_DIR/pi" <<'SCRIPT'
#!/bin/sh
printf '\033]0;%s\007' "π - unnamed-project"
while IFS= read -r line; do
  case "$line" in
    title:*) printf '\033]0;%s\007' "${line#title:}" ;;
    quit) exit 0 ;;
  esac
done
SCRIPT

chmod +x "$FAKE_DIR/claude" "$FAKE_DIR/codex" "$FAKE_DIR/pi"

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

# --- Real attached-client driving ---------------------------------------
#
# command-prompt and choose-tree only run for an attached client. We attach
# one for real by running `tmux -L $SOCK attach` as the sole pane of a
# second, outer tmux server and driving it with send-keys; capture-pane on
# that outer pane shows exactly what a real terminal attached to the inner
# session would render, prompts and popups included.
attach_client() {
  # $1 = target window in the inner session (default: w)
  target=${1:-w}
  TESTN=$((TESTN + 1))
  OUTER_SOCK="tmux-autoname-test-outer-$$-$TESTN"
  SERVERS="$SERVERS $OUTER_SOCK"
  tmux -L "$OUTER_SOCK" -f /dev/null new-session -d -x 200 -y 50 \
    "tmux -L $SOCK attach -t $target"
  sleep 0.5 # let the attach settle before the first send-keys
}

detach_client() {
  tmux -L "$OUTER_SOCK" kill-server >/dev/null 2>&1 || true
}

client_send() {
  tmux -L "$OUTER_SOCK" send-keys "$@"
}

client_capture() {
  tmux -L "$OUTER_SOCK" capture-pane -p 2>/dev/null
}

client_wait_for() {
  # $1 = substring that must appear somewhere in the outer client's screen
  needle=$1
  i=0
  while [ "$i" -lt 60 ]; do
    got=$(client_capture) || got=""
    case "$got" in
      *"$needle"*) return 0 ;;
    esac
    i=$((i + 1))
    sleep 0.05
  done
  return 1
}

start_agent() {
  # $1 = agent name (claude|codex|pi), $2 = target pane (default: w)
  agent=$1
  target=${2:-w}
  t send-keys -t "$target" "exec -a $agent sh $FAKE_DIR/$agent" Enter
}

set_title() {
  # $1 = title text, $2 = target pane (default: w)
  target=${2:-w}
  t send-keys -t "$target" "title:$1" Enter
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

test_claude_glyph_and_spinner() {
  start_server
  load_plugin
  start_agent claude
  assert_eq "claude placeholder ignored" '#{window_name}' '~'
  set_title '✳ Worktree review'
  assert_eq "claude glyph stripped into title" '#{window_name}' '~/Worktree review'
  set_title '⠂ Worktree review'
  assert_eq "spinner glyph change keeps label" '#{window_name}' '~/Worktree review'
  stop_server
}

test_claude_new_title_replaces() {
  start_server
  load_plugin
  start_agent claude
  set_title '✳ Task A'
  assert_eq "first title applied" '#{window_name}' '~/Task A'
  set_title '✳ Task B'
  assert_eq "new title replaces old" '#{window_name}' '~/Task B'
  stop_server
}

test_codex_suffix() {
  start_server
  load_plugin
  start_agent codex
  assert_eq "codex placeholder (no separator) ignored" '#{window_name}' '~'
  set_title 'thread title | project-name'
  assert_eq "codex trailing project stripped" '#{window_name}' '~/thread title'
  stop_server
}

test_codex_spinner_glyph() {
  start_server
  load_plugin
  start_agent codex
  assert_eq "codex placeholder (no separator) ignored" '#{window_name}' '~'
  set_title '⠸ ⠸ | dotfiles'
  assert_eq "codex glyph-only candidate before a thread title is a placeholder" '#{window_name}' '~'
  set_title '⠸ Summarize tmux configuration | dotfiles'
  assert_eq "codex spinner glyph stripped from title" '#{window_name}' '~/Summarize tmux configuration'
  set_title 'Summarize tmux configuration | dotfiles'
  assert_eq "codex title without spinner is not stale" '#{window_name}' '~/Summarize tmux configuration'
  set_title '⠹ Summarize tmux configuration | dotfiles'
  assert_eq "codex spinner reappearing keeps the same title" '#{window_name}' '~/Summarize tmux configuration'
  set_title '⠴ Different task now | dotfiles'
  assert_eq "codex new title while spinner active replaces old" '#{window_name}' '~/Different task now'
  stop_server
}

test_pi_named_and_unnamed() {
  start_server
  load_plugin
  start_agent pi
  assert_eq "pi unnamed session ignored" '#{window_name}' '~'
  set_title 'π - myname - /home/user/proj'
  assert_eq "pi session name extracted" '#{window_name}' '~/myname'
  stop_server
}

test_sticky_after_exit() {
  start_server
  load_plugin
  t set-option -t w remain-on-exit on
  start_agent claude
  set_title '✳ Sticky Task'
  assert_eq "title set before exit" '#{window_name}' '~/Sticky Task'
  t send-keys -t w 'quit' Enter
  sleep 0.3
  assert_eq "title stays after agent exits" '#{window_name}' '~/Sticky Task'
  stop_server
}

test_active_pane_wins() {
  start_server
  load_plugin
  t split-window -t w
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  # pane2 is the newly split, active pane.
  start_agent claude "$pane1"
  start_agent claude "$pane2"
  sleep 0.2
  set_title 'Task from inactive' "$pane1"
  set_title 'Task from active' "$pane2"
  assert_eq "active pane's title wins" '#{@tmux-autoname-title}' 'Task from active'
  stop_server
}

test_inactive_title_used_when_active_has_none() {
  start_server
  load_plugin
  t split-window -t w
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  # pane2 is active and stays a plain shell (no agent).
  start_agent claude "$pane1"
  sleep 0.2
  set_title 'Task from background agent' "$pane1"
  assert_eq "background agent's title used" '#{@tmux-autoname-title}' 'Task from background agent'
  stop_server
}

test_non_agent_ignored() {
  start_server
  load_plugin
  t send-keys -t w "exec -a notanagent sh $FAKE_DIR/claude" Enter
  sleep 0.2
  t send-keys -t w 'title:Should not appear' Enter
  assert_eq "non-agent pane title ignored" '#{window_name}' '~'
  stop_server
}

test_git_workspace() {
  repo_dir=$(mktemp -d)
  (cd "$repo_dir" && git init -q && git commit -q --allow-empty -m init)
  git -C "$repo_dir" worktree add -q "$repo_dir-wt" HEAD >/dev/null 2>&1
  start_server "$repo_dir"
  load_plugin
  assert_eq "git main repo basename" '#{window_name}' "$(basename "$repo_dir")"
  t new-window -t w -c "$repo_dir-wt"
  assert_eq "worktree maps to main repo" '#{window_name}' "$(basename "$repo_dir")" 'w:1'
  stop_server
  git -C "$repo_dir" worktree remove --force "$repo_dir-wt" >/dev/null 2>&1 || true
  rm -rf "$repo_dir" "$repo_dir-wt"
}

test_session_container_workspace() {
  container_dir=$(mktemp -d)
  proj_dir="$container_dir/myproj"
  mkdir -p "$proj_dir/sub"
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  # session_path's basename equals the session name, so any pane at or
  # under it uses the session name as Workspace.
  tmux -L "$SOCK" -f /dev/null new-session -d -s myproj -x 200 -y 50 -c "$proj_dir"
  load_plugin
  assert_eq "session path basename matches session name" '#{window_name}' 'myproj' 'myproj'
  # "myproj:" (not bare "myproj"), since window 0 is itself now named
  # "myproj" - an unqualified target would be ambiguous between the session
  # and that window.
  t new-window -t myproj: -c "$proj_dir/sub"
  assert_eq "pane under session_path also uses session name" '#{window_name}' 'myproj' 'myproj:1'
  stop_server
  rm -rf "$container_dir"
}

test_session_container_ancestor_is_not_enough() {
  outer_dir=$(mktemp -d)
  nested_dir="$outer_dir/dev/partjobs"
  mkdir -p "$nested_dir"
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  # Session "dev" started at $HOME, not under outer_dir/dev: session_path's
  # basename is not "dev" (or if it is, it isn't nested_dir's ancestor), so
  # a pane merely nested under an unrelated directory also named "dev" must
  # not be mistaken for the session's own container.
  tmux -L "$SOCK" -f /dev/null new-session -d -s dev -x 200 -y 50 -c "$HOME"
  load_plugin
  t new-window -t dev -c "$nested_dir"
  assert_eq "unrelated ancestor sharing the session name is not the workspace" \
    '#{window_name}' 'partjobs' 'dev:1'
  stop_server
  rm -rf "$outer_dir"
}

test_truncation_cjk() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell \
    "'$BIN' set -t $win 一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰" >/dev/null 2>&1
  sleep 0.3
  name=$(t display-message -p -t w '#{window_name}')
  case "$name" in
    *…) pass "truncated CJK title ends with ellipsis" ;;
    *) fail "truncated CJK title ends with ellipsis (got $name)" ;;
  esac
  full_label=$(t display-message -p -t w '#{@tmux-autoname-label}')
  want_label='~/一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰'
  if [ "$full_label" = "$want_label" ]; then
    pass "full label kept untruncated in @tmux-autoname-label"
  else
    fail "full label kept untruncated in @tmux-autoname-label (got $full_label)"
  fi
  stop_server
}

test_set_clear_auto() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell "'$BIN' set -t $win Pinned Title" >/dev/null 2>&1
  assert_eq "set pins a title" '#{window_name}' '~/Pinned Title'
  start_agent claude
  set_title '✳ Agent Task'
  assert_eq "pin resists agent titles" '#{window_name}' '~/Pinned Title'
  tmux -L "$SOCK" run-shell "'$BIN' clear -t $win" >/dev/null 2>&1
  assert_eq "clear drops pin and title" '#{window_name}' '~'
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
  assert_eq "auto forgets manual rename and re-syncs" '#{window_name}' '~'
  stop_server
}

test_empty_rename_restores_auto() {
  start_server
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  t rename-window -t w mymanualname
  sleep 0.2
  t rename-window -t w ""
  assert_eq 'empty rename-window "" restores automatic naming' '#{window_name}' '~'
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
    @tmux-autoname-badge-style @tmux-autoname-install-badge; do
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

test_loader_syncs_all_windows() {
  start_server
  t new-window -t w -c "$HOME"
  t new-window -t w -c "$HOME"
  load_plugin
  assert_eq "window 0 named on load" '#{window_name}' '~' 'w:0'
  assert_eq "window 1 named on load" '#{window_name}' '~' 'w:1'
  assert_eq "window 2 named on load" '#{window_name}' '~' 'w:2'
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
    '#{window_name}' '~' 'second:0'
  t kill-session -t second
  stop_server
}

status_field() {
  # $1 = window target, $2 = field name (as printed by `status`)
  tmux -L "$SOCK" run-shell "'$BIN' status -t $1" 2>/dev/null |
    sed -n "s/^$2: //p"
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
  if [ "$(status_field w:1 manual)" = "yes" ]; then
    pass "old manual state: status reports manual"
  else
    fail "old manual state: status reports manual"
  fi
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

  assert_eq "old automatic state: new plugin takes over" '#{window_name}' '~' 'w:2'
  if [ "$(status_field w:2 manual)" = "no" ]; then
    pass "old automatic state: status reports automatic"
  else
    fail "old automatic state: status reports automatic"
  fi
  if [ -z "$(t show-option -t w:2 -wqv @tmux-autoname-state 2>/dev/null)" ]; then
    pass "old automatic state: @tmux-autoname-state unset"
  else
    fail "old automatic state: @tmux-autoname-state unset"
  fi

  if [ "$(status_field w:3 manual)" = "yes" ]; then
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
  if [ "$(status_field w:4 manual)" = "yes" ]; then
    pass "fresh install manual heuristic: status reports manual"
  else
    fail "fresh install manual heuristic: status reports manual"
  fi

  assert_eq "fresh window with automatic-rename on stays automatic" '#{window_name}' '~' 'w:5'

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
  start_agent claude
  set_title '✳ Still Works'
  assert_eq "inherited TMUX_AUTONAME_BIN is not used to resolve the binary" \
    '#{window_name}' '~/Still Works'
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
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell "'$wrapper' set -t $win Via Wrapper" >/dev/null 2>&1
  assert_eq "a @tmux-autoname-bin set before load is honoured" '#{window_name}' '~/Via Wrapper'
  if [ "$(t show-option -gqv @tmux-autoname-bin 2>/dev/null)" = "$wrapper" ]; then
    pass "the loader does not overwrite a user-set @tmux-autoname-bin"
  else
    fail "the loader does not overwrite a user-set @tmux-autoname-bin"
  fi
  stop_server
}

test_key_set_binding_prefill_and_apostrophe() {
  start_server
  t set-option -g @tmux-autoname-key-set 'M-r'
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell "'$BIN' set -t $win Old Pin" >/dev/null 2>&1

  attach_client w
  client_send C-b M-r
  if client_wait_for 'tmux-autoname set: Old Pin'; then
    pass "key-set binding prefills the current pin"
  else
    fail "key-set binding prefills the current pin (got: $(client_capture | tail -1))"
  fi
  client_send C-u
  client_send -l "JC's Task"
  client_send Enter
  detach_client
  assert_eq "apostrophe in a pinned title round-trips" '#{window_name}' "~/JC's Task"
  stop_server
}

test_key_set_binding_prefills_sticky_title_when_no_pin() {
  start_server
  t set-option -g @tmux-autoname-key-set 'M-r'
  load_plugin
  start_agent claude
  set_title '✳ Some Task'
  assert_eq "sticky title set from agent" '#{window_name}' '~/Some Task'

  attach_client w
  client_send C-b M-r
  if client_wait_for 'tmux-autoname set: Some Task'; then
    pass "key-set binding prefills the sticky title when there is no pin"
  else
    fail "key-set binding prefills the sticky title when there is no pin (got: $(client_capture | tail -1))"
  fi
  client_send Escape
  detach_client
  stop_server
}

test_picker_format_no_duplicate_index() {
  start_server
  t set-option -g @tmux-autoname-key-pick 'M-p'
  load_plugin
  win=$(t display-message -p -t w '#{window_id}')
  tmux -L "$SOCK" run-shell "'$BIN' set -t $win Pinned Title" >/dev/null 2>&1

  attach_client w
  client_send C-b M-p
  if client_wait_for '~/Pinned Title'; then
    pass "picker shows the full label"
  else
    fail "picker shows the full label (got: $(client_capture))"
  fi
  screen=$(client_capture)
  case "$screen" in
    *"0: 0:"* | *"0:0:"*)
      fail "picker window row has no duplicate index (got: $screen)"
      ;;
    *)
      pass "picker window row has no duplicate index"
      ;;
  esac
  client_send Escape
  detach_client
  stop_server
}

run_all() {
  test_claude_glyph_and_spinner
  test_claude_new_title_replaces
  test_codex_suffix
  test_codex_spinner_glyph
  test_pi_named_and_unnamed
  test_sticky_after_exit
  test_active_pane_wins
  test_inactive_title_used_when_active_has_none
  test_non_agent_ignored
  if command -v git >/dev/null 2>&1; then
    test_git_workspace
  fi
  test_session_container_workspace
  test_session_container_ancestor_is_not_enough
  test_truncation_cjk
  test_set_clear_auto
  test_manual_rename_respected
  test_auto_restores_after_manual
  test_empty_rename_restores_auto
  test_loader_syncs_all_windows
  test_session_created_hook_registered
  test_key_set_binding_prefill_and_apostrophe
  test_key_set_binding_prefills_sticky_title_when_no_pin
  test_picker_format_no_duplicate_index
  test_migration
  test_migration_window_state
  test_loader_ignores_inherited_bin_env_var
  test_loader_honours_bin_option_set_before_load
}

run_all

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAIL_LIST"
  exit 1
fi
exit 0
