#!/usr/bin/env sh
# End-to-end tests for tmux-autoname, run against real isolated tmux
# servers. See docs/adr/0006-rewrite-with-icons.md for the behaviour under
# test.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
BIN="$REPO_DIR/bin/tmux-autoname"
PLUGIN="$REPO_DIR/tmux-autoname.tmux"

# Never talk to the server this suite was started from: every tmux call
# below names its own socket with -L, and the plugin only runs inside those
# servers through run-shell.
unset TMUX TMUX_PANE TMUX_AUTONAME_BIN 2>/dev/null || true
REAL_TMUX=$(command -v tmux)
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE 2>/dev/null || true

# Every test tmux server we spawn below picks its default-shell from $SHELL
# at server-start time. Force a plain POSIX sh regardless of the host's own
# login shell (e.g. an interactive zsh with a fancy multi-line prompt can
# swallow or misinterpret scripted send-keys), so the suite is deterministic.
export SHELL=/bin/sh

# Built-in icons, as UTF-8 bytes.
ICON_VIM=$(printf '\356\230\253')         # U+E62B
ICON_CLAUDE=$(printf '\342\234\273')      # U+273B
ICON_AGENT=$(printf '\363\260\232\251')   # U+F06A9
ICON_REMOTE=$(printf '\363\260\243\200')  # U+F08C0
ICON_MONITOR=$(printf '\363\260\215\233') # U+F035B
ICON_PYTHON=$(printf '\356\230\206')      # U+E606
ICON_GIT=$(printf '\363\260\212\242')     # U+F02A2
ICON_FILES=$(printf '\363\260\211\213')   # U+F024B
ICON_PAGER=$(printf '\363\260\210\231')   # U+F0219
ICON_SHELL=$(printf '\357\222\211')       # U+F489
ICON_DEFAULT=$(printf '\363\260\206\215') # U+F018D

PASS=0
FAIL=0
FAIL_LIST=""

WORK=$(mktemp -d)
FAKE_DIR="$WORK/fake"
mkdir -p "$FAKE_DIR"
# new-window and split-window without -c start in the client's cwd: keep
# that out of any git repository (such as this checkout).
cd "$WORK"
SERVERS=""
SOCK=""

# shellcheck disable=SC2317,SC2329  # invoked indirectly via trap
cleanup() {
  for s in $SERVERS; do
    tmux -L "$s" kill-server >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# Fake program: reads "title:<text>" lines from stdin and re-emits the title
# via OSC 0, or exits on "quit". pane_current_command reports argv[0] of
# the pane's foreground process, so tests run this as
# `exec as NAME sh -c '. plain' [ARGS]`: argv is then
# `NAME -c '. plain' ARGS`, which also lets ssh tests choose their argv.
# `as` stands in for `exec -a`, which dash does not have.
cat >"$FAKE_DIR/as" <<'SCRIPT'
#!/bin/sh
# as NAME PROG [ARGS]: exec PROG with argv[0] set to NAME.
exec perl -e 'my $n = shift; my $p = shift; exec {$p} $n, @ARGV or die "$p: $!\n"' -- "$@"
SCRIPT
chmod +x "$FAKE_DIR/as"
cat >"$FAKE_DIR/plain" <<'SCRIPT'
while IFS= read -r line; do
  case "$line" in
    title:*) printf '\033]0;%s\007' "${line#title:}" ;;
    quit) exit 0 ;;
  esac
done
SCRIPT

TESTN=0
new_server() {
  # $1 = session name, $2 = cwd for its first window
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  t -f /dev/null new-session -d -s "$1" -x 200 -y 50 -c "$2"
}

start_server() {
  # $1 = cwd for the initial window (default: a fresh non-git directory).
  # The session is "w", which never matches the cwd's basename.
  new_server w "${1:-$(fixture)}"
}

stop_server() {
  tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
}

fixture() {
  # Print a fresh directory under $WORK, outside any git repository.
  mktemp -d "$WORK/fx.XXXXXX"
}

init_repo() {
  # $1 = directory to turn into a git repo with one commit
  git -C "$1" init -q
  git -C "$1" -c core.hooksPath=/dev/null -c user.name=test \
    -c user.email=test@example.invalid commit -q --allow-empty -m "chore: init"
}

load_plugin() {
  t run-shell "$PLUGIN"
  # The loader syncs every window in the background. Let it finish first,
  # or a late rename from it can race a test's own manual rename.
  i=0
  while [ "$i" -lt 60 ] &&
    t list-windows -a -F '#{@tmux-autoname-applied}' 2>/dev/null | grep -q '^$'; do
    i=$((i + 1))
    sleep 0.05
  done
}

t() {
  # -u: print UTF-8 icons as-is whatever the locale.
  tmux -u -L "$SOCK" "$@"
}

gset() {
  # $1 = global option, $2 = value
  t set-option -g "$1" "$2"
}

wait_cmd() {
  # $1 = expected pane_current_command, $2 = target (default: w)
  wait_for '#{pane_current_command}' "$1" "${2:-w}" || true
}

start_fake() {
  # $1 = name to exec as, $2 = target pane (default: w), $3 = extra argv
  target=${2:-w}
  t send-keys -t "$target" "exec $FAKE_DIR/as $1 sh -c '. $FAKE_DIR/plain'${3:+ $3}" Enter
  wait_cmd "$1" "$target"
}

start_child() {
  # Like start_fake, but in a subshell, so "quit" returns to the pane's sh.
  # $1 = name, $2 = target pane (default: w)
  target=${2:-w}
  t send-keys -t "$target" "(exec $FAKE_DIR/as $1 sh -c '. $FAKE_DIR/plain')" Enter
  wait_cmd "$1" "$target"
}

quit_child() {
  # Ends the child running in window w.
  t send-keys -t w quit Enter
  wait_cmd sh w
}

set_title() {
  # $1 = title text, $2 = target pane (default: w)
  target=${2:-w}
  t send-keys -t "$target" "title:$1" Enter
  wait_for '#{pane_title}' "$1" "$target" || true
}

run_bin() {
  # Run the binary inside the test server. $@ = arguments (no quotes)
  t run-shell "'$BIN' $*" 2>/dev/null || true
}

bin_out() {
  # Run the binary against the test server and print its output. tmux 3.4
  # does not return run-shell output to a detached client.
  TMUX="$(sock_path),0,0" "$BIN" "$@" 2>/dev/null || true
}

sync_now() {
  # $1 = target pane or window (default: w)
  run_bin sync -t "${1:-w}" >/dev/null
}

sock_path() {
  t display-message -p '#{socket_path}'
}

run_direct() {
  # Run $1 (a script) as from outside tmux: no $TMUX, no locale. A tmux
  # wrapper first in PATH pins every call to the test server's socket.
  # $@ after $1 = arguments
  script=$1
  shift
  wrap="$WORK/wrap-$SOCK"
  mkdir -p "$wrap"
  printf '#!/bin/sh\nexec \047%s\047 -S \047%s\047 "$@"\n' "$REAL_TMUX" "$(sock_path)" \
    >"$wrap/tmux"
  chmod +x "$wrap/tmux"
  env -i PATH="$wrap:$PATH" HOME="$HOME" sh "$script" "$@" >/dev/null 2>&1 ||
    true
}

win_id() {
  # Prints the id of window w.
  t display-message -p -t w '#{window_id}'
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
    pass "$desc"
  else
    got=$(t display-message -p -t "$target" "$fmt" 2>/dev/null) || got="<error>"
    fail "$desc (want $want, got $got)"
  fi
}

assert_name() {
  # $1 = description, $2 = expected window name, $3 = target (default: w)
  assert_eq "$1" '#{window_name}' "$2" "${3:-w}"
}

assert_icon() {
  # $1 = description, $2 = expected icon, $3 = target (default: w)
  assert_eq "$1" '#{@tmux-autoname-icon}' "$2" "${3:-w}"
}

check() {
  # $1 = description; the rest is a command that must succeed
  desc=$1
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
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

# --- Name grammar -----------------------------------------------------------

test_name_activity_only() {
  start_server
  load_plugin
  start_fake claude
  sync_now
  assert_name "A: workspace equal to the session is omitted by default" 'claude'
  stop_server
}

test_name_omit_session_off() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  start_fake claude
  sync_now
  assert_name "A:W: omit-session off keeps the session workspace" 'claude:w'
  stop_server
}

test_name_session_container_area() {
  base=$(fixture)
  mkdir -p "$base/partjobs/patent-value-identification"
  # session_path is the session's first cwd, so it must be the directory
  # named like the session for the session-container rule to apply.
  new_server partjobs "$base/partjobs"
  load_plugin
  t send-keys -t partjobs:0 "cd $base/partjobs/patent-value-identification" Enter
  start_fake zsh partjobs:0
  sync_now partjobs:0
  assert_name "A:R: session container, omit-session on" \
    'zsh:patent-value-identification' partjobs:0
  gset @tmux-autoname-omit-session off
  sync_now partjobs:0
  assert_name "A:W/R: session container, omit-session off" \
    'zsh:partjobs/patent-value-identification' partjobs:0
  stop_server
}

test_name_session_container_root() {
  base=$(fixture)
  mkdir -p "$base/tmux-autoname"
  new_server tmux-autoname "$base/tmux-autoname"
  load_plugin
  start_fake claude tmux-autoname:0
  sync_now tmux-autoname:0
  assert_name "A: session-container root, omit-session on" 'claude' tmux-autoname:0
  gset @tmux-autoname-omit-session off
  sync_now tmux-autoname:0
  assert_name "A:W: session-container root has no area" \
    'claude:tmux-autoname' tmux-autoname:0
  stop_server
}

test_name_session_container_beats_git() {
  base=$(fixture)
  mkdir -p "$base/partjobs/paxc-approx-dnn"
  init_repo "$base/partjobs/paxc-approx-dnn"
  new_server partjobs "$base/partjobs"
  load_plugin
  t new-window -t partjobs: -c "$base/partjobs/paxc-approx-dnn"
  start_fake claude partjobs:1
  sync_now partjobs:1
  assert_name "session container wins over a git repo inside it" \
    'claude:paxc-approx-dnn' partjobs:1
  gset @tmux-autoname-omit-session off
  sync_now partjobs:1
  assert_name "session container wins over git, omit-session off" \
    'claude:partjobs/paxc-approx-dnn' partjobs:1
  stop_server
}

test_name_git_workspace() {
  base=$(fixture)
  mkdir -p "$base/foo" "$base/bar/src"
  init_repo "$base/bar"
  # Session "dev" starts at .../foo: basename "foo" is not "dev", so the
  # session-container rule does not apply and the git repo wins.
  new_server dev "$base/foo"
  load_plugin
  t new-window -t dev: -c "$base/bar"
  start_fake nvim dev:1
  sync_now dev:1
  assert_name "A:W: git workspace at the repo root, omit-session on" 'nvim:bar' dev:1
  t new-window -t dev: -c "$base/bar/src"
  start_fake nvim dev:2
  sync_now dev:2
  assert_name "A:W/R: git workspace with area, omit-session on" 'nvim:bar/src' dev:2
  stop_server
}

test_name_git_linked_worktree() {
  base=$(fixture)
  mkdir -p "$base/bar"
  init_repo "$base/bar"
  git -C "$base/bar" -c core.hooksPath=/dev/null worktree add -q \
    -b feature "$base/bar-feature"
  mkdir -p "$base/bar-feature/src"
  start_server "$base/bar-feature/src"
  load_plugin
  start_fake zsh
  sync_now
  assert_name "linked worktree: workspace is the worktree directory" 'zsh:bar-feature/src'
  stop_server
}

test_name_session_name_workspace() {
  base=$(fixture)
  mkdir -p "$base/sub/deeper"
  start_server "$base/sub/deeper"
  gset @tmux-autoname-omit-session off
  load_plugin
  sync_now
  assert_name "session-name workspace has no root, so no area" 'sh:w'
  gset @tmux-autoname-omit-session on
  sync_now
  assert_name "session-name workspace omitted, no area" 'sh'
  stop_server
}

test_area_depth() {
  base=$(fixture)
  mkdir -p "$base/bar/src/utils/deep"
  init_repo "$base/bar"
  start_server "$base/bar/src/utils/deep"
  load_plugin
  start_fake zsh
  sync_now
  assert_name "area capped to its first segment by default (depth 1)" 'zsh:bar/src'
  gset @tmux-autoname-area-depth 2
  sync_now
  assert_name "area capped to two segments with depth 2" 'zsh:bar/src/utils'
  gset @tmux-autoname-area-depth 0
  sync_now
  assert_name "area kept in full with depth 0 (unlimited)" 'zsh:bar/src/utils/deep'
  stop_server
}

# --- Remote hosts -----------------------------------------------------------

test_ssh_host_from_argv() {
  base=$(fixture)
  mkdir -p "$base/bar/src"
  init_repo "$base/bar"
  # The pane's cwd is inside a repo: the remote host still wins, no area.
  start_server "$base/bar/src"
  load_plugin
  # argv: ssh -c <script> -p 22 -i key jc@Gentoo-Box uptime; -c, -p and -i
  # each take a value, so the first positional is jc@Gentoo-Box.
  start_fake ssh w:0 '-p 22 -i key jc@Gentoo-Box uptime'
  sync_now w:0
  assert_name "ssh host from argv: options skipped, user@ stripped, lower-cased" \
    'ssh:gentoo-box' w:0
  assert_icon "ssh gets the remote icon" "$ICON_REMOTE" w:0
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:1 '-o BatchMode=yes ssh://jc@Build-Host:2222'
  sync_now w:1
  assert_name "ssh host from argv: ssh:// scheme and :port stripped" \
    'ssh:build-host' w:1
  # -ljc: the value is attached, though "c" alone would also take one.
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:2 '-ljc Gentoo-Box'
  sync_now w:2
  assert_name "ssh host from argv: a value attached in a cluster" \
    'ssh:gentoo-box' w:2
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:3 '-vl jc Gentoo-Box'
  sync_now w:3
  assert_name "ssh host from argv: a cluster ending in -l takes the next arg" \
    'ssh:gentoo-box' w:3
  stop_server
}

test_ssh_host_from_title() {
  start_server
  load_plugin
  # argv is just "ssh -c <script>": no positional, so the title is parsed.
  start_fake ssh
  set_title 'jc@Gentoo-Box: ~'
  sync_now
  assert_name "ssh host falls back to pane_title when argv has none" 'ssh:gentoo-box'
  stop_server
}

test_mosh_host_from_argv() {
  start_server
  load_plugin
  # A mosh process (not mosh-client) carries the user's host in argv; the
  # title names the local host and must not win.
  start_fake mosh w '--ssh=ssh jc@Gentoo-Box'
  set_title 'jc@thinkpad: ~'
  sync_now
  assert_name "mosh host from argv, not the local host in pane_title" 'mosh:gentoo-box'
  stop_server
}

test_mosh_host_from_title() {
  start_server
  load_plugin
  # mosh-client's argv is an IP and port, never the user's host.
  start_fake mosh-client w '10.0.0.1 60001'
  set_title 'jc@Gentoo-Box: ~'
  sync_now
  assert_name "mosh-client is mosh, host from pane_title not argv" 'mosh:gentoo-box'
  assert_icon "mosh gets the remote icon" "$ICON_REMOTE"
  stop_server
}

# --- Activity ---------------------------------------------------------------

test_activity_coding_agent_stripped() {
  start_server
  load_plugin
  start_fake pi-coding-agent
  sync_now
  assert_name "pi-coding-agent activity strips the -coding-agent suffix" 'pi'
  assert_icon "pi gets the agent icon" "$ICON_AGENT"
  stop_server
}

test_activity_sanitized() {
  start_server
  load_plugin
  start_fake Foo:Bar_1
  sync_now
  assert_name "activity lower-cased, characters outside [a-z0-9._+-] dropped" 'foobar_1'
  stop_server
}

test_node_script_resolves_to_program() {
  start_server
  load_plugin
  mkdir -p "$FAKE_DIR/pkg/bin"
  # argv becomes "node -s <dir>/pkg/bin/codex", like a node CLI shim;
  # the interactive sh keeps the pane's foreground process alive.
  t send-keys -t w "exec $FAKE_DIR/as node sh -s $FAKE_DIR/pkg/bin/codex" Enter
  wait_cmd node
  sync_now
  assert_name "node running a CLI script resolves to the script name" 'codex'
  assert_icon "the resolved program picks the icon" "$ICON_AGENT"
  stop_server
}

test_launcher_resolves_to_command() {
  start_server
  load_plugin
  # argv becomes "doas -s emerge -auDvN", as for "doas emerge -auDvN".
  t send-keys -t w "exec $FAKE_DIR/as doas sh -s emerge -auDvN" Enter
  wait_cmd doas
  sync_now
  assert_name "doas launching emerge resolves to emerge" 'emerge'
  assert_icon "an unknown program gets the default icon" "$ICON_DEFAULT"
  stop_server
}

# --- Icons ------------------------------------------------------------------

icon_case() {
  # $1 = program to run, $2 = expected icon, $3 = window index
  t new-window -t "w:$3" -c "$ICON_CWD"
  start_fake "$1" "w:$3"
  sync_now "w:$3"
  assert_icon "built-in icon for $1" "$2" "w:$3"
}

test_builtin_icons() {
  ICON_CWD=$(fixture)
  start_server "$ICON_CWD"
  load_plugin
  sync_now w:0
  assert_icon "built-in icon for a bare sh pane" "$ICON_SHELL" w:0
  icon_case claude "$ICON_CLAUDE" 1
  icon_case zsh "$ICON_SHELL" 2
  icon_case nvim "$ICON_VIM" 3
  icon_case vi "$ICON_VIM" 4
  icon_case codex "$ICON_AGENT" 5
  icon_case htop "$ICON_MONITOR" 6
  icon_case ipython "$ICON_PYTHON" 7
  icon_case lazygit "$ICON_GIT" 8
  icon_case yazi "$ICON_FILES" 9
  icon_case less "$ICON_PAGER" 10
  icon_case frobnicate "$ICON_DEFAULT" 11
  # "top" is an exact pattern, not top*.
  icon_case topgrade "$ICON_DEFAULT" 12
  if t display-message -p -t w:1 '#{window_name}' | grep -q "$ICON_CLAUDE"; then
    fail "the icon is not put into the window name"
  else
    pass "the icon is not put into the window name"
  fi
  stop_server
}

test_user_icons() {
  start_server
  gset @tmux-autoname-icons 'cla*=C zs*=Z emerge=E foo=a=b'
  load_plugin
  start_fake claude w:0
  sync_now w:0
  assert_icon "a user icon wins over the built-in one" 'C' w:0
  t new-window -t w:
  start_fake zsh w:1
  sync_now w:1
  assert_icon "a user pattern is a glob" 'Z' w:1
  t new-window -t w:
  start_fake emerge w:2
  sync_now w:2
  assert_icon "a user icon for a program with no built-in icon" 'E' w:2
  t new-window -t w:
  start_fake foo w:3
  sync_now w:3
  assert_icon "a user entry is split at the first =" 'a=b' w:3
  t new-window -t w:
  start_fake nvim w:4
  sync_now w:4
  assert_icon "built-in icons still apply when no user entry matches" "$ICON_VIM" w:4
  stop_server
}

test_icon_default_override() {
  start_server
  gset @tmux-autoname-icon-default 'D'
  load_plugin
  start_fake frobnicate w:0
  sync_now w:0
  assert_icon "@tmux-autoname-icon-default replaces the default icon" 'D' w:0
  t new-window -t w:
  sync_now w:1
  assert_icon "built-in icons still apply with a default override" "$ICON_SHELL" w:1
  stop_server
}

# --- Manual Name ------------------------------------------------------------

test_manual_rename_keeps_updated_icon() {
  start_server
  load_plugin
  start_child claude
  sync_now
  assert_name "automatic name before the manual rename" 'claude'
  assert_icon "icon before the manual rename" "$ICON_CLAUDE"
  t rename-window -t w pinned
  sync_now
  assert_name "a manual rename is not overwritten by sync" 'pinned'
  assert_icon "a manual rename keeps the icon" "$ICON_CLAUDE"
  quit_child
  start_child nvim
  sync_now
  assert_icon "a manual window's icon follows a new program" "$ICON_VIM"
  assert_name "a manual window's name stays when the program changes" 'pinned'
  quit_child
  sync_now
  assert_icon "a manual window's icon follows the program back to sh" "$ICON_SHELL"
  assert_name "a manual window's name still stays" 'pinned'
  stop_server
}

test_auto_restores_after_manual() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  win=$(win_id)
  sync_now "$win"
  t rename-window -t w mymanualname
  sync_now "$win"
  assert_name "manual rename survives sync before auto" 'mymanualname'
  run_bin auto -t "$win" >/dev/null
  assert_name "auto forgets the manual rename and re-syncs" 'sh:w'
  start_fake zsh
  sync_now "$win"
  assert_name "after auto, sync renames the window again" 'zsh:w'
  stop_server
}

test_empty_rename_restores_auto() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  sync_now
  t rename-window -t w mymanualname
  sync_now
  assert_name "manual rename survives sync before rename \"\"" 'mymanualname'
  t rename-window -t w ""
  assert_name 'rename-window "" restores automatic naming' 'sh:w'
  stop_server
}

# --- Window and panes -------------------------------------------------------

test_background_pane_does_not_hijack() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  t split-window -t w
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  # pane2 is the newly split, active pane.
  start_fake claude "$pane1"
  start_fake zsh "$pane2"
  sync_now w
  assert_name "window named from the active pane (zsh)" 'zsh:w'
  # The background pane (claude) triggers a sync of its own: the window
  # must still reflect the active pane.
  sync_now "$pane1"
  assert_name "a background pane's sync does not hijack the name" 'zsh:w'
  assert_icon "a background pane's sync does not hijack the icon" "$ICON_SHELL"
  stop_server
}

test_after_kill_pane_syncs_window() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  # Losing the active pane also fires these; only after-kill-pane may sync.
  t set-hook -gu 'window-pane-changed[120]'
  t set-hook -gu 'after-select-window[120]'
  t set-hook -gu 'window-linked[120]'
  t split-window -t w
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  start_fake zsh "$pane1"
  start_fake nvim "$pane2"
  sync_now w
  assert_name "window named from the active pane (nvim) before kill" 'nvim:w'
  t kill-pane -t "$pane2"
  assert_name "after-kill-pane renames from the remaining active pane" 'zsh:w'
  assert_icon "after-kill-pane updates the icon" "$ICON_SHELL"
  stop_server
}

test_break_pane_syncs_new_window() {
  start_server
  load_plugin
  t split-window -t w
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  start_fake nvim "$pane2"
  t break-pane -d -s "$pane2" -t w:5
  assert_name "a window made by break-pane is named" 'nvim' w:5
  assert_icon "a window made by break-pane gets its icon" "$ICON_VIM" w:5
  stop_server
}

# --- Tricky names -----------------------------------------------------------

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
status_has() {
  # $1 = target window, $2 = exact line wanted in its status output
  out=$(bin_out status -t "$1")
  has_line "$out" "$2"
}

tricky_case() {
  # $1 = directory name under the session container, $2 = window index,
  # $3 = expected name ("" = skip the name check)
  mkdir -p "$TRICKY_BASE/box/$1"
  # new-window -c format-expands, and a word ending in ";" ends a command.
  dir=$(printf '%s' "$TRICKY_BASE/box/$1" | sed -e 's/#/##/g' -e 's/;$/\\;/')
  t new-window -d -t "box:$2" -c "$dir"
  sync_now "box:$2"
  sync_now "box:$2"
  [ -z "$3" ] || assert_name "name from a directory named $1" "$3" "box:$2"
  check "a directory named $1 does not make a Manual Name" \
    status_has "box:$2" 'manual: no'
}

test_tricky_names() {
  TRICKY_BASE=$(fixture)
  mkdir -p "$TRICKY_BASE/box"
  new_server box "$TRICKY_BASE/box"
  load_plugin
  tricky_case 'C#' 1 'sh:C#'
  tricky_case '##x' 2 'sh:##x'
  tricky_case '#{session_name}' 3 'sh:#{session_name}'
  tricky_case 'semi;' 4 'sh:semi;'
  tricky_case 'b\slash' 5 ''
  tricky_case "$(printf 'a\ttab')" 6 'sh:atab'
  stop_server
}

wrapped_sync() {
  # Run "sync -t w" with a tmux wrapper first in PATH. $1 = sh code the
  # wrapper runs before each call, with "$@" set to that call's arguments
  # and $real set to the real tmux on the test socket.
  wrap="$WORK/wrapped-$SOCK"
  mkdir -p "$wrap"
  {
    printf '#!/bin/sh\n'
    printf 'real="%s -S %s"\n' "$REAL_TMUX" "$(sock_path)"
    printf '%s\n' "$1"
    # shellcheck disable=SC2016
    printf 'exec $real "$@"\n'
  } >"$wrap/tmux"
  chmod +x "$wrap/tmux"
  TMUX="$(sock_path),0,0" PATH="$wrap:$PATH" "$BIN" sync -t w \
    >/dev/null 2>&1 || true
}

test_rename_during_sync_is_kept() {
  start_server
  load_plugin
  start_fake claude
  sync_now
  gset @tmux-autoname-omit-session off
  # The user renames the window after sync read it, before sync writes.
  # shellcheck disable=SC2016
  wrapped_sync 'case " $* " in *" if-shell "*) $real rename-window -t w mine ;; esac'
  assert_name "a rename made during a sync is kept" 'mine'
  check "a rename made during a sync is a Manual Name" \
    status_has w 'manual: yes'
  stop_server
}

test_sync_retries_after_another_sync() {
  start_server
  load_plugin
  start_fake claude
  sync_now
  gset @tmux-autoname-omit-session off
  mark="$WORK/other-sync.mark"
  rm -f "$mark"
  # Once, just before the write, another sync stores an older name.
  wrapped_sync "case \" \$* \" in *' if-shell '*)
  [ -e '$mark' ] || { : >'$mark'; \$real rename-window -t w sh:w \; \
    set-option -wq -t w @tmux-autoname-applied sh:w; } ;; esac"
  assert_name "a sync that loses to another sync reads again and retries" \
    'claude:w'
  stop_server
}

test_backslash_name_not_renamed_again() {
  base=$(fixture)
  mkdir -p "$base/box/b\\slash"
  new_server box "$base/box"
  load_plugin
  t send-keys -t box "cd 'b\\slash'" Enter
  wait_for '#{b:pane_current_path}' 'b\slash' box || true
  sync_now box
  log="$WORK/backslash.log"
  : >"$log"
  # shellcheck disable=SC2016
  wrapped_sync "printf '%s\\n' \"\$*\" >>'$log'"
  check "a name with a backslash is not renamed on every sync" \
    not_in_log rename-window "$log"
  stop_server
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
not_in_log() {
  # $1 = text, $2 = file
  ! grep -qF -- "$1" "$2"
}

test_no_utf8_locale() {
  base=$(fixture)
  mkdir -p "$base/项目"
  init_repo "$base/项目"
  start_server "$base/项目"
  run_direct "$BIN" sync -t w
  assert_name "sync works without a UTF-8 locale, non-ASCII kept" 'sh:项目'
  assert_icon "the icon is set without a UTF-8 locale" "$ICON_SHELL"
  stop_server
}

# --- zsh integration --------------------------------------------------------

test_zsh_cancels_delayed_sync() {
  stub="$FAKE_DIR/stub-sync"
  log="$WORK/stub-sync.log"
  cat >"$stub" <<SCRIPT
#!/bin/sh
printf '%s\\n' "\$*" >>'$log'
SCRIPT
  chmod +x "$stub"
  start_server
  t send-keys -t w "env TMUX_AUTONAME_BIN='$stub' PS1='%% ' zsh -f -i" Enter
  wait_cmd zsh
  t send-keys -t w "source '$REPO_DIR/integrations/tmux-autoname.zsh'" Enter
  sleep 0.5
  : >"$log"
  # The command ends before the 0.3 s delay: only the prompt's sync runs.
  t send-keys -t w 'sleep 0.1' Enter
  sleep 1
  n=$(wc -l <"$log" | tr -d ' ')
  if [ "$n" = 1 ]; then
    pass "zsh: a command shorter than the delay leaves one sync, not two"
  else
    fail "zsh: a command shorter than the delay leaves one sync (got $n)"
  fi
  : >"$log"
  t send-keys -t w 'sleep 0.6' Enter
  sleep 1.2
  n=$(wc -l <"$log" | tr -d ' ')
  if [ "$n" = 2 ]; then
    pass "zsh: a longer command gets the delayed sync and the prompt's sync"
  else
    fail "zsh: a longer command gets two syncs (got $n)"
  fi
  stop_server
}

# --- Loader -----------------------------------------------------------------

test_loader_syncs_all_windows() {
  start_server
  gset @tmux-autoname-omit-session off
  t new-window -t w:
  t new-window -t w:
  t new-session -d -s other -c "$(fixture)"
  load_plugin
  for target in w:0 w:1 w:2 other:0; do
    assert_icon "loader sets the icon on $target" "$ICON_SHELL" "$target"
  done
  assert_name "loader names w:0" 'sh:w' w:0
  assert_name "loader names w:1" 'sh:w' w:1
  assert_name "loader names w:2" 'sh:w' w:2
  assert_name "loader names a window of another session" 'sh:other' other:0
  stop_server
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
hook_has() {
  # $1 = hook name, $2 = text its [120] entry must contain. Window hooks
  # (window-pane-changed) are listed by -gw, the others by -g.
  { t show-hooks -g; t show-hooks -gw; } 2>/dev/null |
    grep "^$1\\[120\\] " | grep -qF -- "$2"
}

test_hooks_registered() {
  start_server
  gset @tmux-autoname-omit-session off
  load_plugin
  for hook in after-new-window after-select-window window-pane-changed \
    after-split-window client-attached session-created after-kill-pane \
    window-linked after-rename-window; do
    check "${hook}[120] hook registered" hook_has "$hook" "$BIN"
  done
  check "after-rename-window is guarded by an empty-name test" \
    hook_has after-rename-window '#{==:#{window_name},}'
  check "sync hooks target the window by id" \
    hook_has after-kill-pane "sync -t '#{window_id}'"
  t new-window -t w:
  assert_name "after-new-window names the new window" 'sh:w' w:1
  assert_icon "after-new-window sets the new window's icon" "$ICON_SHELL" w:1
  t new-session -d -s second -c "$(fixture)"
  assert_name "session-created names the new session's first window" 'sh:second' second:0
  stop_server
}

test_loader_quoted_path() {
  # A checkout path with characters special to sh, tmux and formats.
  dir="$WORK/it's a \"dir\" \$HOME #1"
  mkdir -p "$dir/bin"
  cp "$PLUGIN" "$dir/"
  cp "$BIN" "$dir/bin/"
  start_server
  gset @tmux-autoname-omit-session off
  run_direct "$dir/tmux-autoname.tmux"
  t new-window -t w:
  assert_name "hooks run from a checkout path with quotes, \$ and #" 'sh:w' w:1
  t rename-window -t w:1 manual
  t rename-window -t w:1 ""
  assert_name "the rename hook runs from a checkout path with quotes" 'sh:w' w:1
  stop_server
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
env_is_bin() {
  [ "$(t show-environment -g TMUX_AUTONAME_BIN 2>/dev/null)" = "TMUX_AUTONAME_BIN=$BIN" ]
}

test_loader_exports_bin() {
  start_server
  gset @tmux-autoname-omit-session off
  stale_bin="$FAKE_DIR/stale-tmux-autoname"
  cat >"$stale_bin" <<'SCRIPT'
#!/bin/sh
tmux rename-window stale
SCRIPT
  chmod +x "$stale_bin"
  # @tmux-autoname-bin is gone: the loader always uses its own checkout.
  gset @tmux-autoname-bin "$stale_bin"
  load_plugin
  check "TMUX_AUTONAME_BIN in the global environment is this checkout's bin" \
    env_is_bin
  t new-window -t w:
  assert_name "a leftover @tmux-autoname-bin is ignored" 'sh:w' w:1
  stop_server
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
no_key_bound() {
  ! t list-keys 2>/dev/null | grep -q tmux-autoname
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
key_bound_to_auto() {
  # $1 = key
  t list-keys 2>/dev/null | grep " $1 " | grep -q "tmux-autoname.* auto"
}

test_key_auto_binding() {
  start_server
  load_plugin
  check "no key is bound when @tmux-autoname-key-auto is unset" \
    no_key_bound
  stop_server

  start_server
  gset @tmux-autoname-key-auto 'M-a'
  load_plugin
  check "key-auto binds the key to auto" \
    key_bound_to_auto M-a
  stop_server
}

# --- status -----------------------------------------------------------------

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
has_line() {
  # $1 = text, $2 = exact line wanted
  printf '%s\n' "$1" | grep -qxF -- "$2"
}

test_status_output() {
  start_server
  load_plugin
  start_fake claude
  win=$(win_id)
  sync_now "$win"
  out=$(bin_out status -t "$win")
  check "status: name line" has_line "$out" 'name: claude'
  check "status: applied line" has_line "$out" 'applied: claude'
  check "status: manual line, automatic window" has_line "$out" 'manual: no'
  check "status: activity line" has_line "$out" 'activity: claude'
  check "status: icon line" has_line "$out" "icon: $ICON_CLAUDE"
  t rename-window -t w pinned
  out=$(bin_out status -t "$win")
  check "status: name line after a manual rename" has_line "$out" 'name: pinned'
  check "status: applied line keeps the automatic name" has_line "$out" 'applied: claude'
  check "status: manual line, manual window" has_line "$out" 'manual: yes'
  check "status: activity line on a manual window" has_line "$out" 'activity: claude'
  stop_server
}

run_all() {
  test_name_activity_only
  test_name_omit_session_off
  test_name_session_container_area
  test_name_session_container_root
  test_name_session_name_workspace
  if command -v git >/dev/null 2>&1; then
    test_name_session_container_beats_git
    test_name_git_workspace
    test_name_git_linked_worktree
    test_area_depth
    test_ssh_host_from_argv
  fi
  test_ssh_host_from_title
  test_mosh_host_from_argv
  test_mosh_host_from_title
  test_activity_coding_agent_stripped
  test_activity_sanitized
  if [ -r /proc/self/stat ]; then
    test_node_script_resolves_to_program
    test_launcher_resolves_to_command
  fi
  test_builtin_icons
  test_user_icons
  test_icon_default_override
  test_manual_rename_keeps_updated_icon
  test_auto_restores_after_manual
  test_empty_rename_restores_auto
  test_background_pane_does_not_hijack
  test_after_kill_pane_syncs_window
  test_break_pane_syncs_new_window
  test_tricky_names
  test_rename_during_sync_is_kept
  test_sync_retries_after_another_sync
  test_backslash_name_not_renamed_again
  if command -v git >/dev/null 2>&1; then
    test_no_utf8_locale
  fi
  if command -v zsh >/dev/null 2>&1; then
    test_zsh_cancels_delayed_sync
  fi
  test_loader_syncs_all_windows
  test_hooks_registered
  test_loader_quoted_path
  test_loader_exports_bin
  test_key_auto_binding
  test_status_output
}

run_all

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAIL_LIST"
  exit 1
fi
exit 0
