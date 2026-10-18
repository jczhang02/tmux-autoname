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
ICON_CLAUDE=$(printf '\356\262\202')      # U+EC82
ICON_CODEX=$(printf '\356\262\201')       # U+EC81
ICON_AGENT=$(printf '\363\260\232\251')   # U+F06A9
ICON_REMOTE=$(printf '\363\260\243\200')  # U+F08C0
ICON_MONITOR=$(printf '\363\260\215\233') # U+F035B
ICON_PYTHON=$(printf '\356\230\206')      # U+E606
ICON_GIT=$(printf '\363\260\212\242')     # U+F02A2
ICON_FILES=$(printf '\363\260\211\213')   # U+F024B
ICON_PAGER=$(printf '\363\260\210\231')   # U+F0219
ICON_SHELL=$(printf '\357\222\211')       # U+F489
ICON_DEFAULT=$(printf '\363\260\206\215') # U+F018D
ICON_GENTOO=$(printf '\357\214\215')        # U+F30D
ICON_NODE=$(printf '\363\260\216\231')      # U+F0399
ICON_CONTAINER=$(printf '\363\260\241\250') # U+F0868
ICON_TEX=$(printf '\356\240\237')           # U+E81F
ICON_BUILD=$(printf '\363\260\243\252')     # U+F08EA
ICON_NETWORK=$(printf '\363\260\226\237')   # U+F059F
ICON_GITHUB=$(printf '\363\260\212\244')    # U+F02A4
ICON_TMUX=$(printf '\356\257\210')          # U+EBC8

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

kill_server() {
  # $1 = socket name. tmux 3.8 leaves the socket file behind on
  # kill-server, so remove it too.
  tmux -L "$1" kill-server >/dev/null 2>&1 || true
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$1"
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via trap
cleanup() {
  for s in $SERVERS; do
    kill_server "$s"
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
  # $1 = session name, $2 = cwd for its first window, $3 = HOME of the
  # server, which run-shell and so sync get (default: this HOME)
  TESTN=$((TESTN + 1))
  SOCK="tmux-autoname-test-$$-$TESTN"
  SERVERS="$SERVERS $SOCK"
  env HOME="${3:-$HOME}" tmux -u -L "$SOCK" -f /dev/null new-session -d \
    -s "$1" -x 200 -y 50 -c "$2"
}

start_server() {
  # $1 = cwd for the initial window (default: a fresh non-git directory
  # named "plain", which is then the window's name). The session is "w",
  # which never matches the cwd's basename.
  new_server w "${1:-$(named_dir plain)}"
}

stop_server() {
  kill_server "$SOCK"
}

fixture() {
  # Print a fresh directory under $WORK, outside any git repository.
  mktemp -d "$WORK/fx.XXXXXX"
}

named_dir() {
  # Print a fresh directory named $1, outside any git repository.
  d="$(fixture)/$1"
  mkdir -p "$d"
  printf '%s' "$d"
}

init_repo() {
  # $1 = directory to turn into a git repo with one commit
  git -C "$1" init -q -b main
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

assert_activity() {
  # $1 = description, $2 = expected Activity, $3 = target (default: w)
  check "$1" status_has "${3:-w}" "activity: $2"
}

cd_pane() {
  # $1 = directory, $2 = target pane (default: w). Waits for the cd.
  t send-keys -t "${2:-w}" "cd '$1'" Enter
  wait_for '#{pane_current_path}' "$1" "${2:-w}" || true
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

test_name_directory_fallback() {
  start_server
  load_plugin
  start_fake claude
  sync_now
  assert_name "no Project, Task or Git: the directory name" 'plain'
  stop_server
}

test_name_home_directory() {
  home=$(named_dir home)
  new_server w "$home" "$home"
  sync_now
  assert_name "the home directory is named ~" '~'
  stop_server
}

test_name_session_container() {
  base=$(fixture)
  mkdir -p "$base/partjobs/patent-value-identification/manuscript" \
    "$base/partjobs/notes/sub"
  init_repo "$base/partjobs/patent-value-identification"
  # session_path is the session's first cwd, so it must be the directory
  # named like the session for the session-container rule to apply.
  new_server partjobs "$base/partjobs"
  load_plugin
  sync_now partjobs:0
  assert_name "a session-container root without Git: the directory name" \
    'partjobs' partjobs:0
  t new-window -t partjobs: -c "$base/partjobs/patent-value-identification/manuscript"
  start_fake claude partjobs:1
  sync_now partjobs:1
  assert_name "P: a Git project on main, its subdirectory left out" \
    'patent-value-identification' partjobs:1
  t new-window -t partjobs: -c "$base/partjobs/notes/sub"
  sync_now partjobs:2
  assert_name "P: without Git, the first directory below the container" \
    'notes' partjobs:2
  stop_server
}

test_name_task_branch() {
  base=$(fixture)
  mkdir -p "$base/partjobs/pvi/src"
  init_repo "$base/partjobs/pvi"
  git -C "$base/partjobs/pvi" checkout -q -b ch4-selector
  new_server partjobs "$base/partjobs"
  load_plugin
  t new-window -t partjobs: -c "$base/partjobs/pvi"
  sync_now partjobs:1
  assert_name "P/T: a task branch in a session container" \
    'pvi/ch4-selector' partjobs:1
  stop_server

  new_server pvi "$base/partjobs/pvi"
  load_plugin
  sync_now pvi:0
  assert_name "T: a Project equal to the session name is left out" \
    'ch4-selector' pvi:0
  git -C "$base/partjobs/pvi" checkout -q main
  sync_now pvi:0
  assert_name "neither Project nor Task: the branch" 'main' pvi:0
  t new-window -t pvi: -c "$base/partjobs/pvi/src"
  sync_now pvi:1
  assert_name "a subdirectory does not change the name" 'main' pvi:1
  git -C "$base/partjobs/pvi" checkout -q --detach
  sync_now pvi:0
  assert_name "neither Project, Task nor branch: the directory name" \
    'pvi' pvi:0
  stop_server
}

test_name_branch_edge_cases() {
  base=$(fixture)
  mkdir -p "$base/partjobs/unborn" "$base/partjobs/tagged"
  # A branch with no commit yet is still a Task.
  git -C "$base/partjobs/unborn" init -q -b feature
  init_repo "$base/partjobs/tagged"
  git -C "$base/partjobs/tagged" checkout -q -b v1
  git -C "$base/partjobs/tagged" tag v1
  new_server partjobs "$base/partjobs"
  load_plugin
  t new-window -t partjobs: -c "$base/partjobs/unborn"
  sync_now partjobs:1
  assert_name "a branch with no commit yet is the Task" \
    'unborn/feature' partjobs:1
  t new-window -t partjobs: -c "$base/partjobs/tagged"
  sync_now partjobs:2
  assert_name "a branch named like a tag has no heads/ prefix" \
    'tagged/v1' partjobs:2
  git -C "$base/partjobs/tagged" checkout -q -b worktree-
  sync_now partjobs:2
  assert_name "a branch named only worktree- keeps its name" \
    'tagged/worktree-' partjobs:2
  stop_server
}

test_name_old_git() {
  fake="$WORK/old-git"
  mkdir -p "$fake"
  # Git older than 2.31 prints an unknown --path-format option back.
  cat >"$fake/git" <<SCRIPT
#!/bin/sh
for a in "\$@"; do
  case "\$a" in --path-format=*) printf '%s\\n' "\$a" ;; esac
done
exec '$(command -v git)' "\$@"
SCRIPT
  chmod +x "$fake/git"
  base=$(fixture)
  mkdir -p "$base/bar"
  init_repo "$base/bar"
  git -C "$base/bar" checkout -q -b feat
  start_server "$base/bar"
  TMUX="$(sock_path),0,0" PATH="$fake:$PATH" "$BIN" sync -t w \
    >/dev/null 2>&1 || true
  assert_name "Git older than 2.31 counts as no Git" 'bar'
  stop_server
}

test_name_git_project() {
  base=$(fixture)
  mkdir -p "$base/foo" "$base/bar/src"
  init_repo "$base/bar"
  # Session "dev" starts at .../foo: basename "foo" is not "dev", so the
  # session-container rule does not apply.
  new_server dev "$base/foo"
  load_plugin
  t new-window -t dev: -c "$base/bar/src"
  start_fake nvim dev:1
  sync_now dev:1
  assert_name "P: a Git project that differs from the session" 'bar' dev:1
  stop_server
}

test_name_linked_worktree() {
  base=$(fixture)
  mkdir -p "$base/partjobs/paxc"
  init_repo "$base/partjobs/paxc"
  wt="$base/partjobs/paxc/.claude/worktrees/report-clarity"
  git -C "$base/partjobs/paxc" worktree add -q -b worktree-report-clarity "$wt"
  new_server partjobs "$base/partjobs"
  load_plugin
  t new-window -t partjobs: -c "$wt"
  sync_now partjobs:1
  assert_name "a linked worktree: main repository, branch without worktree-" \
    'paxc/report-clarity' partjobs:1
  stop_server

  new_server paxc "$base/partjobs/paxc"
  load_plugin
  t new-window -t paxc: -c "$wt"
  sync_now paxc:1
  assert_name "a linked worktree in its repository's session: the Task" \
    'report-clarity' paxc:1
  stop_server
}

test_name_submodule() {
  base=$(fixture)
  mkdir -p "$base/libsrc" "$base/super"
  init_repo "$base/libsrc"
  init_repo "$base/super"
  git -C "$base/super" -c protocol.file.allow=always submodule add -q \
    "$base/libsrc" lib >/dev/null 2>&1
  start_server "$base/super/lib"
  load_plugin
  sync_now
  assert_name "a submodule keeps its own name" 'lib'
  stop_server
}

# --- Remote hosts -----------------------------------------------------------

test_ssh_host_from_argv() {
  base=$(fixture)
  mkdir -p "$base/bar/src"
  init_repo "$base/bar"
  # The pane's cwd is inside a repo: the remote host still wins, no Task.
  start_server "$base/bar/src"
  load_plugin
  # argv: ssh -c <script> -p 22 -i key jc@Gentoo-Box uptime; -c, -p and -i
  # each take a value, so the first positional is jc@Gentoo-Box.
  start_fake ssh w:0 '-p 22 -i key jc@Gentoo-Box uptime'
  sync_now w:0
  assert_name "ssh host from argv: options skipped, user@ stripped, lower-cased" \
    'gentoo-box' w:0
  assert_icon "ssh gets the remote icon" "$ICON_REMOTE" w:0
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:1 '-o BatchMode=yes ssh://jc@Build-Host:2222'
  sync_now w:1
  assert_name "ssh host from argv: ssh:// scheme and :port stripped" \
    'build-host' w:1
  # -ljc: the value is attached, though "c" alone would also take one.
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:2 '-ljc Gentoo-Box'
  sync_now w:2
  assert_name "ssh host from argv: a value attached in a cluster" \
    'gentoo-box' w:2
  t new-window -t w: -c "$base/bar/src"
  start_fake ssh w:3 '-vl jc Gentoo-Box'
  sync_now w:3
  assert_name "ssh host from argv: a cluster ending in -l takes the next arg" \
    'gentoo-box' w:3
  stop_server
}

test_ssh_host_from_title() {
  start_server
  load_plugin
  # argv is just "ssh -c <script>": no positional, so the title is parsed.
  start_fake ssh
  set_title 'jc@Gentoo-Box: ~'
  sync_now
  assert_name "ssh host falls back to pane_title when argv has none" 'gentoo-box'
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
  assert_name "mosh host from argv, not the local host in pane_title" 'gentoo-box'
  stop_server
}

test_mosh_host_from_title() {
  start_server
  load_plugin
  # mosh-client's argv is an IP and port, never the user's host.
  start_fake mosh-client w '10.0.0.1 60001'
  set_title 'jc@Gentoo-Box: ~'
  sync_now
  assert_name "mosh-client is mosh, host from pane_title not argv" 'gentoo-box'
  assert_icon "mosh gets the remote icon" "$ICON_REMOTE"
  stop_server
}

# --- Activity ---------------------------------------------------------------

test_activity_coding_agent_stripped() {
  start_server
  load_plugin
  start_fake pi-coding-agent
  sync_now
  assert_activity "pi-coding-agent activity strips the -coding-agent suffix" 'pi'
  assert_icon "pi gets the agent icon" "$ICON_AGENT"
  stop_server
}

test_activity_sanitized() {
  start_server
  load_plugin
  start_fake Foo:Bar_1
  sync_now
  assert_activity "activity lower-cased, characters outside [a-z0-9._+-] dropped" 'foobar_1'
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
  assert_activity "node running a CLI script resolves to the script name" 'codex'
  assert_icon "the resolved program picks the icon" "$ICON_CODEX"
  stop_server
}

test_launcher_resolves_to_command() {
  start_server
  load_plugin
  # argv becomes "doas -s emerge -auDvN", as for "doas emerge -auDvN".
  t send-keys -t w "exec $FAKE_DIR/as doas sh -s emerge -auDvN" Enter
  wait_cmd doas
  sync_now
  assert_activity "doas launching emerge resolves to emerge" 'emerge'
  assert_icon "doas emerge gets the Gentoo icon" "$ICON_GENTOO"
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
  icon_case codex "$ICON_CODEX" 5
  icon_case htop "$ICON_MONITOR" 6
  icon_case ipython "$ICON_PYTHON" 7
  icon_case lazygit "$ICON_GIT" 8
  icon_case yazi "$ICON_FILES" 9
  icon_case less "$ICON_PAGER" 10
  icon_case frobnicate "$ICON_DEFAULT" 11
  # "top" is an exact pattern, not top*.
  icon_case topgrade "$ICON_DEFAULT" 12
  icon_case emerge "$ICON_GENTOO" 13
  # npm's argv names npm-cli.js, which resolves to npm-cli.
  icon_case npm-cli "$ICON_NODE" 14
  icon_case podman "$ICON_CONTAINER" 15
  icon_case latexmk "$ICON_TEX" 16
  icon_case make "$ICON_BUILD" 17
  icon_case curl "$ICON_NETWORK" 18
  icon_case gh "$ICON_GITHUB" 19
  icon_case sesh "$ICON_TMUX" 20
  if t display-message -p -t w:1 '#{window_name}' | grep -q "$ICON_CLAUDE"; then
    fail "the icon is not put into the window name"
  else
    pass "the icon is not put into the window name"
  fi
  stop_server
}

test_user_icons() {
  start_server
  gset @tmux-autoname-icons 'cla*=C zs*=Z frob=E foo=a=b'
  load_plugin
  start_fake claude w:0
  sync_now w:0
  assert_icon "a user icon wins over the built-in one" 'C' w:0
  t new-window -t w:
  start_fake zsh w:1
  sync_now w:1
  assert_icon "a user pattern is a glob" 'Z' w:1
  t new-window -t w:
  start_fake frob w:2
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
  assert_name "automatic name before the manual rename" 'plain'
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
  dir=$(named_dir plain)
  mkdir -p "$dir/sub"
  start_server "$dir"
  load_plugin
  win=$(win_id)
  sync_now "$win"
  t rename-window -t w mymanualname
  sync_now "$win"
  assert_name "manual rename survives sync before auto" 'mymanualname'
  run_bin auto -t "$win" >/dev/null
  assert_name "auto forgets the manual rename and re-syncs" 'plain'
  cd_pane "$dir/sub"
  sync_now "$win"
  assert_name "after auto, sync renames the window again" 'sub'
  stop_server
}

test_empty_rename_restores_auto() {
  start_server
  load_plugin
  sync_now
  t rename-window -t w mymanualname
  sync_now
  assert_name "manual rename survives sync before rename \"\"" 'mymanualname'
  t rename-window -t w ""
  assert_name 'rename-window "" restores automatic naming' 'plain'
  stop_server
}

# --- Window and panes -------------------------------------------------------

test_background_pane_does_not_hijack() {
  start_server "$(named_dir pa)"
  load_plugin
  t split-window -t w -c "$(named_dir pb)"
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  # pane2 is the newly split, active pane.
  start_fake claude "$pane1"
  start_fake zsh "$pane2"
  sync_now w
  assert_name "window named from the active pane" 'pb'
  # The background pane (claude) triggers a sync of its own: the window
  # must still reflect the active pane.
  sync_now "$pane1"
  assert_name "a background pane's sync does not hijack the name" 'pb'
  assert_icon "a background pane's sync does not hijack the icon" "$ICON_SHELL"
  stop_server
}

test_after_kill_pane_syncs_window() {
  start_server "$(named_dir pa)"
  load_plugin
  # Losing the active pane also fires these; only after-kill-pane may sync.
  t set-hook -gu 'window-pane-changed[120]'
  t set-hook -gu 'after-select-window[120]'
  t set-hook -gu 'window-linked[120]'
  t split-window -t w -c "$(named_dir pb)"
  pane1=$(t list-panes -t w -F '#{pane_id}' | sed -n 1p)
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  start_fake zsh "$pane1"
  start_fake nvim "$pane2"
  sync_now w
  assert_name "window named from the active pane before kill" 'pb'
  t kill-pane -t "$pane2"
  assert_name "after-kill-pane renames from the remaining active pane" 'pa'
  assert_icon "after-kill-pane updates the icon" "$ICON_SHELL"
  stop_server
}

test_break_pane_syncs_new_window() {
  start_server
  load_plugin
  t split-window -t w -c "$(named_dir brk)"
  pane2=$(t list-panes -t w -F '#{pane_id}' | sed -n 2p)
  start_fake nvim "$pane2"
  t break-pane -d -s "$pane2" -t w:5
  assert_name "a window made by break-pane is named" 'brk' w:5
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
  tricky_case 'C#' 1 'C#'
  tricky_case '##x' 2 '##x'
  tricky_case '#{session_name}' 3 '#{session_name}'
  tricky_case 'semi;' 4 'semi;'
  tricky_case 'b\slash' 5 ''
  tricky_case "$(printf 'a\ttab')" 6 'atab'
  # tmux expands a leading ~ even inside double quotes.
  tricky_case '~x' 7 '~x'
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
  dir=$(named_dir plain)
  mkdir -p "$dir/sub"
  start_server "$dir"
  load_plugin
  sync_now
  cd_pane "$dir/sub"
  # The user renames the window after sync read it, before sync writes.
  # shellcheck disable=SC2016
  wrapped_sync 'case " $* " in *" if-shell "*) $real rename-window -t w mine ;; esac'
  assert_name "a rename made during a sync is kept" 'mine'
  check "a rename made during a sync is a Manual Name" \
    status_has w 'manual: yes'
  stop_server
}

test_sync_retries_after_another_sync() {
  dir=$(named_dir plain)
  mkdir -p "$dir/sub"
  start_server "$dir"
  load_plugin
  sync_now
  cd_pane "$dir/sub"
  mark="$WORK/other-sync.mark"
  rm -f "$mark"
  # Once, just before the write, another sync stores an older name.
  wrapped_sync "case \" \$* \" in *' if-shell '*)
  [ -e '$mark' ] || { : >'$mark'; \$real rename-window -t w older \; \
    set-option -wq -t w @tmux-autoname-applied older; } ;; esac"
  assert_name "a sync that loses to another sync reads again and retries" \
    'sub'
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
  assert_name "sync works without a UTF-8 locale, non-ASCII kept" '项目'
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

test_zsh_finds_own_bin() {
  # The first pane of a new server starts before the loader exports
  # TMUX_AUTONAME_BIN, and the bin is not on PATH.
  checkout="$WORK/checkout"
  log="$WORK/own-bin.log"
  mkdir -p "$checkout/bin" "$checkout/integrations"
  cp "$REPO_DIR/integrations/tmux-autoname.zsh" "$checkout/integrations/"
  cat >"$checkout/bin/tmux-autoname" <<SCRIPT
#!/bin/sh
printf '%s\\n' "\$*" >>'$log'
SCRIPT
  chmod +x "$checkout/bin/tmux-autoname"
  start_server
  t send-keys -t w "env -u TMUX_AUTONAME_BIN PS1='%% ' zsh -f -i" Enter
  wait_cmd zsh
  t send-keys -t w "source '$checkout/integrations/tmux-autoname.zsh'" Enter
  sleep 0.5
  : >"$log"
  t send-keys -t w 'true' Enter
  sleep 0.5
  if grep -q '^sync -t %' "$log"; then
    pass "zsh: without TMUX_AUTONAME_BIN, syncs with its own checkout's bin"
  else
    fail "zsh: without TMUX_AUTONAME_BIN, syncs with its own checkout's bin"
  fi
  stop_server
}

# --- Loader -----------------------------------------------------------------

test_loader_syncs_all_windows() {
  dir=$(named_dir plain)
  start_server "$dir"
  t new-window -t w: -c "$dir"
  t new-window -t w: -c "$dir"
  t new-session -d -s other -c "$(named_dir elsewhere)"
  load_plugin
  for target in w:0 w:1 w:2 other:0; do
    assert_icon "loader sets the icon on $target" "$ICON_SHELL" "$target"
  done
  assert_name "loader names w:0" 'plain' w:0
  assert_name "loader names w:1" 'plain' w:1
  assert_name "loader names w:2" 'plain' w:2
  assert_name "loader names a window of another session" 'elsewhere' other:0
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
  t new-window -t w: -c "$(named_dir fresh)"
  assert_name "after-new-window names the new window" 'fresh' w:1
  assert_icon "after-new-window sets the new window's icon" "$ICON_SHELL" w:1
  t new-session -d -s second -c "$(named_dir second)"
  assert_name "session-created names the new session's first window" 'second' second:0
  stop_server
}

test_loader_quoted_path() {
  # A checkout path with characters special to sh, tmux and formats.
  dir="$WORK/it's a \"dir\" \$HOME #1"
  mkdir -p "$dir/bin"
  cp "$PLUGIN" "$dir/"
  cp "$BIN" "$dir/bin/"
  start_server
  run_direct "$dir/tmux-autoname.tmux"
  t new-window -t w: -c "$(named_dir fresh)"
  assert_name "hooks run from a checkout path with quotes, \$ and #" 'fresh' w:1
  t rename-window -t w:1 manual
  t rename-window -t w:1 ""
  assert_name "the rename hook runs from a checkout path with quotes" 'fresh' w:1
  stop_server
}

# shellcheck disable=SC2317,SC2329  # invoked indirectly via check
env_is_bin() {
  [ "$(t show-environment -g TMUX_AUTONAME_BIN 2>/dev/null)" = "TMUX_AUTONAME_BIN=$BIN" ]
}

test_loader_exports_bin() {
  start_server
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
  t new-window -t w: -c "$(named_dir fresh)"
  assert_name "a leftover @tmux-autoname-bin is ignored" 'fresh' w:1
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
  check "status: name line" has_line "$out" 'name: plain'
  check "status: applied line" has_line "$out" 'applied: plain'
  check "status: manual line, automatic window" has_line "$out" 'manual: no'
  check "status: activity line" has_line "$out" 'activity: claude'
  check "status: icon line" has_line "$out" "icon: $ICON_CLAUDE"
  check "status: project line" has_line "$out" 'project: w'
  check "status: task line" has_line "$out" 'task: '
  t rename-window -t w pinned
  out=$(bin_out status -t "$win")
  check "status: name line after a manual rename" has_line "$out" 'name: pinned'
  check "status: applied line keeps the automatic name" has_line "$out" 'applied: plain'
  check "status: manual line, manual window" has_line "$out" 'manual: yes'
  check "status: activity line on a manual window" has_line "$out" 'activity: claude'
  stop_server
}

run_all() {
  test_name_directory_fallback
  test_name_home_directory
  if command -v git >/dev/null 2>&1; then
    test_name_session_container
    test_name_task_branch
    test_name_branch_edge_cases
    test_name_old_git
    test_name_git_project
    test_name_linked_worktree
    test_name_submodule
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
    test_zsh_finds_own_bin
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
