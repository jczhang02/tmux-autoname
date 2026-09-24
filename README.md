# tmux-autoname

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname mirrors the title your coding agent already gives its own
work onto the tmux window name. It makes no model calls, captures no
pane text, and needs no API key: Claude Code, codex, and pi each set a
terminal title through OSC, tmux already records it as `pane_title`, and
this plugin copies it into the window name.

```text
tmux-autoname/Mirror agent titles instead of inferring them
partjobs/查看当前工作情况
website/fix mobile navigation
```

The window name is `<workspace>/<title>`, or just `<workspace>` when no
recognised agent has reported a title yet. See
[docs/adr/0004-mirror-agent-titles.md](docs/adr/0004-mirror-agent-titles.md)
for the full design rationale.

## Why this exists

Earlier versions of this plugin inferred a task from screen text with an
LLM. That required a config file, an API key, a resident daemon, and a
Bun build step, and the inferred name often described the current step
rather than the goal. Agents already name their own work; this version
just reads it.

## Requirements

- tmux 3.3 or newer
- POSIX `sh` (the default on Linux and macOS)
- `git`, optional, for the Workspace name

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

## Agents supported

| Agent | `pane_current_command` | Raw title example | Normalised Task |
|---|---|---|---|
| Claude Code | `claude` | `✳ Worktree review` | `Worktree review` |
| codex | `codex` | `查看当前工作情况 \| bllc-reproduction` | `查看当前工作情况` |
| pi | `pi` | `π - reviewer - myproj` | `reviewer` |

A placeholder title - Claude Code's `Claude Code`, codex before it sets
a thread title, or an unnamed pi session (`π - <cwd>` with no session
name) - counts as no title, and the window keeps showing only its
Workspace. Only the Window's active pane and, if different, the pane
whose title just changed are considered; when several agent panes share
a Window the active pane wins. Once a Task is recorded it sticks to the
Window - it survives the agent exiting and is only replaced by a new
meaningful title from an agent in that Window.

Add or remove recognised commands with `@tmux-autoname-agents` (default
`claude codex pi`).

## pi session names

pi shows `π - <cwd>` until a session is named with `/name` or by an
extension. `integrations/pi/session-title.ts` closes that gap: after the
first agent turn, if the session still has no name, it asks the current
model for a short title of the user's first message and calls
`pi.setSessionName()`. It fails silently and never blocks a turn.

Install it by pointing pi at the file, e.g. with `-e
~/.tmux/plugins/tmux-autoname/integrations/pi/session-title.ts` or by
adding it to your pi config's extensions list.

## Workspace

The Workspace is computed once and then fixed for the life of the
window (until `clear`):

1. **Session-container rule.** If an ancestor directory of the pane's
   path has the same basename as the tmux session, use the session name.
2. **Git repository.** Otherwise, the basename of the main git
   repository (`git rev-parse --path-format=absolute --git-common-dir`).
   A worktree maps to its main repository.
3. **Directory.** Otherwise, the basename of the current directory.
   `$HOME` is shown as `~`.

Before any Task is recorded, the Workspace is recomputed on every sync
and simply follows the pane's current path.

## Commands

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname set [-t window] <title...>
tmux-autoname clear [-t window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` recomputes a window's name. Hooks call this for you; you
  normally don't need to.
- `set` pins a title that agent titles cannot replace, e.g.
  `tmux-autoname set Reviewing the payments PR`.
- `clear` drops the pin, the sticky agent title, and the fixed
  Workspace, returning the window to a Workspace-only name.
- `auto` forgets a manual `tmux rename-window` and re-syncs immediately.
- `status` prints the window's Workspace, title source, sticky title,
  pin, full label, and whether the name was manually overridden.

A user rename (tmux's own `prefix` + <kbd>,</kbd>, or `rename-window`)
takes precedence until you run `tmux-autoname auto` or rename the window
to an empty string (`tmux rename-window ""`), which restores automatic
naming.

## Options

| Option | Default | Meaning |
|---|---|---|
| `@tmux-autoname-agents` | `claude codex pi` | Space-separated `pane_current_command` values that contribute titles |
| `@tmux-autoname-max-width` | `32` | Display cells before the window name is truncated with `…` |
| `@tmux-autoname-key-set` | unset | Key, bound in the `prefix` table, that prompts for a pin with the current label prefilled |
| `@tmux-autoname-key-clear` | unset | Key that clears the current window |
| `@tmux-autoname-key-pick` | unset | Key that opens `choose-tree` showing full labels |

Set these before the plugin loads:

```tmux
set -g @tmux-autoname-max-width 40
set -g @tmux-autoname-key-set 'M-r'
set -g @tmux-autoname-key-clear 'M-c'
set -g @tmux-autoname-key-pick 'M-p'
```

The full, untruncated label is always available as
`#{@tmux-autoname-label}`, for use in your own `window-status-format`.

## Upgrading from 0.5 and earlier

0.6 removes the TypeScript/Bun runtime, the inference daemon, the config
file, and the window-tab badge entirely - there is nothing to build and
nothing to configure. Loading the new `tmux-autoname.tmux` migrates a
prior install automatically: it stops the old daemon, overwrites the old
indexed hooks, removes the badge fragment it had appended to your
`window-status-format`/`window-status-current-format`, and unsets its
obsolete global options. Existing Manual Names (windows you renamed
yourself) are left untouched. See
[CHANGELOG.md](CHANGELOG.md) for details.

## Limits

- Naming quality now equals the agent's own title quality. A window
  without a recognised agent shows only its Workspace.
- Claude Code keeps its first-topic title, which can lag a long
  session's current focus; `tmux-autoname set` or the agent's own
  rename command fixes that.
- Only `claude`, `codex`, and `pi` are recognised out of the box; other
  tools that set a terminal title can be added via `@tmux-autoname-agents`
  if their title format needs no special normalisation, or need a small
  patch to `normalize_title()` in `bin/tmux-autoname` if it does.

## Development and verification

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` starts real, isolated tmux servers (`tmux -L
tmux-autoname-test-*`) and drives them with fake `claude`/`codex`/`pi`
processes that emit real OSC title sequences, so it exercises the actual
hooks and format regexes, not a reimplementation of them.
