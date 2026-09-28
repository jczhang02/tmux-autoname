# tmux-autoname

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname names tmux windows deterministically from what is actually
running and where: no model calls, no screen capture, no API key, and no
agent-title mirroring.

```text
claude:tmux-autoname
zsh:partjobs/patent-value-identification
codex:partjobs/patent-value-identification
ssh:gentoo-box
```

The window name is `<activity>:<workspace>[/<area>]`. See
[docs/adr/0005-restore-deterministic-naming.md](docs/adr/0005-restore-deterministic-naming.md)
for the full design rationale.

## Why this exists

Earlier versions of this plugin inferred a task from screen text with an
LLM, then a later version mirrored the title a coding agent already sets
for itself. Both were dropped: inferred tasks described the current step
rather than the goal, and agent titles were mostly in whatever language
the agent used, changed with pane focus, and made windows in the same
session indistinguishable once the Area was gone. This version restores
the deterministic, local rule the maintainer actually used every day
before either of those.

## Requirements

- tmux 3.3 or newer
- POSIX `sh` (the default on Linux and macOS)
- `git`, optional, for the Git Workspace candidate
- `zsh`, optional, for the recommended `integrations/tmux-autoname.zsh`

No build step and no runtime dependency beyond tmux itself.

## Install with TPM

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Press `prefix` + <kbd>I</kbd>. Nothing else to build or configure.

## Install manually

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
```

Load the plugin from `~/.tmux.conf`:

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

Add the plugin's `bin` directory to `PATH` if you want to call its
commands by name instead of through `$TMUX_AUTONAME_BIN` (which the
loader always sets for you):

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

The loader always resolves the binary to `bin/tmux-autoname` inside its
own checkout - it never reads `$TMUX_AUTONAME_BIN` back from the process
environment, so a shell that happens to have it set (e.g. from an old
install) can't pin the server to a stale binary. To point at a different
binary on purpose, set `@tmux-autoname-bin` *before* the plugin loads:

```tmux
set -g @tmux-autoname-bin '/path/to/custom/tmux-autoname'
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

## Recommended: the zsh integration

tmux has no hook that fires when the foreground program changes or the
shell `cd`s. Without help, `tmux-autoname` only recomputes a window's name
on tmux's own structural events - a new window, a pane gaining focus, a
split, a new session, a client attaching. That means the name can lag
behind reality for as long as you stay in the same pane: switching from
`zsh` to `claude` in place, or `cd`-ing into a different project, won't be
reflected until something else nudges tmux.

`integrations/tmux-autoname.zsh` closes that gap and is the recommended
way to run this plugin day to day. Source it from `~/.zshrc`:

```sh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

It hooks `preexec` (sync shortly after a command starts), `precmd` (sync
right before the next prompt), and `chpwd` (sync on `cd`), every one of
them backgrounded and disowned so it never slows down your prompt or
prints a job-control message. It resolves the binary from
`$TMUX_AUTONAME_BIN` (which the loader exports for you) or falls back to
`tmux-autoname` on `$PATH`.

## Naming rule

- **Activity** is `pane_current_command`, lower-cased, with a
  `-coding-agent` suffix stripped (so `pi-coding-agent` becomes `pi`).
  When that command is a launcher (`sudo`, `doas`, `env`, `nice`,
  `timeout`, `systemd-run`, ...) or an interpreter (`node`, `bun`, `deno`,
  `python*`, `ruby`, `perl`), the foreground process's argv is read and
  the real program is used instead: `doas emerge -a` becomes `emerge`,
  `node .../bin/codex` becomes `codex`, `python3 -m http.server` becomes
  `http.server`. An interpreter with no script (a REPL, `-e`/`-c`) keeps
  its own name.
- **Workspace** is the first of these that applies:
  1. For `ssh` or `mosh`, the remote host parsed out of the pane title.
  2. **Session container.** If `#{session_path}`'s basename equals the
     tmux session name, and the pane's path is that directory or under
     it, use the session name.
  3. **Git repository.** Otherwise, the basename of
     `git rev-parse --show-toplevel`.
  4. **Session name.** Otherwise, the session name itself.
- **Area** is the pane's path relative to the winning Workspace's root,
  when the pane is strictly under that root (never `..`, never emitted
  when there is no root, e.g. the `ssh`/`mosh` candidate). It is capped to
  its first `@tmux-autoname-area-depth` path segments (default `1`); set
  it to `0` for the full, unlimited relative path.

## Commands

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` recomputes the name of the window a pane or window id belongs
  to, from that window's currently ACTIVE pane - not the pane you passed,
  if they differ. Hooks (and the zsh integration) call this for you; you
  normally don't need to.
- `auto` forgets a manual `tmux rename-window` and re-syncs immediately.
- `status` prints the window's current name, the name last applied by
  `sync`, and whether it's been manually overridden.

A user rename (tmux's own `prefix` + <kbd>,</kbd>, or `rename-window`)
takes precedence until you run `tmux-autoname auto` or rename the window
to an empty string (`tmux rename-window ""`), which restores automatic
naming.

## Options

| Option | Default | Meaning |
|---|---|---|
| `@tmux-autoname-area-depth` | `1` | Path segments of the Area to keep; `0` for the full relative path |
| `@tmux-autoname-bin` | unset | Path to the `tmux-autoname` binary to use, if not the one in this checkout - must be set before the plugin loads |
| `@tmux-autoname-key-auto` | unset | Key, bound in the `prefix` table, that runs `auto` on the current window |

Set these before the plugin loads:

```tmux
set -g @tmux-autoname-area-depth 0
set -g @tmux-autoname-key-auto 'M-a'
```

## Upgrading from 0.6 and earlier

0.7 removes every AI/agent-title feature 0.6 added: `set`, `clear`, the
Pin, the sticky Task, the fixed Workspace, `@tmux-autoname-agents`,
`@tmux-autoname-max-width`, the `-key-set`/`-key-clear`/`-key-pick`
bindings, the `pane-title-changed` hook, and
`integrations/pi/session-title.ts`. Naming is deterministic again; see
[docs/adr/0005-restore-deterministic-naming.md](docs/adr/0005-restore-deterministic-naming.md).
Loading the new `tmux-autoname.tmux` migrates a prior install
automatically: it stops any lingering pre-0.6 daemon, overwrites the old
indexed hooks, removes the badge fragment 0.5 and earlier appended to your
`window-status-format`/`window-status-current-format`, and unsets all
obsolete global and per-window options from both the pre-0.6 daemon and
0.6 itself.

It also migrates every window's old per-window state left by the pre-0.6
daemon (`@tmux-autoname-state`, base64-encoded JSON, and
`@tmux-autoname-badge`): a window the old daemon had in manual mode is kept
manual (sync will never rename it), one it had in automatic mode is handed
to the new plugin to name from scratch, and both options are then unset. A
window with no old state at all, but whose `automatic-rename` was
explicitly turned off (a plain `tmux rename-window` you did yourself, with
no tmux-autoname involved), is also treated as manual, so a manual rename
survives the upgrade either way. If old state exists but can't be decoded,
the window is treated as manual too - tmux-autoname never overwrites a name
it isn't sure about. See [CHANGELOG.md](CHANGELOG.md) for details.

## Limits

- Without the zsh integration, the Activity and Area only update on
  tmux's own window/pane/session events, not on a foreground-command
  change or `cd` inside the same pane.
- Only `git` is consulted for the Workspace; other version-control
  systems fall back to the session name or the directory basename.

## Development and verification

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` starts real, isolated tmux servers (`tmux -L
tmux-autoname-test-*`) and drives them with fake processes exec'd under
the names it needs to test, so it exercises the actual hooks, not a
reimplementation of them.
