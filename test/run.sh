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
  proj_dir="$container_dir/myproj/sub"
  mkdir -p "$proj_dir"
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  tmux -L "$SOCK" -f /dev/null new-session -d -s myproj -x 200 -y 50 -c "$proj_dir"
  load_plugin
  assert_eq "session-container ancestor picked as workspace" '#{window_name}' 'myproj' 'myproj'
  stop_server
  rm -rf "$container_dir"
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

run_all() {
  test_claude_glyph_and_spinner
  test_claude_new_title_replaces
  test_codex_suffix
  test_pi_named_and_unnamed
  test_sticky_after_exit
  test_active_pane_wins
  test_inactive_title_used_when_active_has_none
  test_non_agent_ignored
  if command -v git >/dev/null 2>&1; then
    test_git_workspace
  fi
  test_session_container_workspace
  test_truncation_cjk
  test_set_clear_auto
  test_manual_rename_respected
  test_auto_restores_after_manual
  test_empty_rename_restores_auto
  test_migration
}

run_all

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAIL_LIST"
  exit 1
fi
exit 0
