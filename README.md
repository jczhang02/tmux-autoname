# tmux-autoname

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname names tmux windows deterministically from what is running
and where, and gives each window an icon for that program. No model calls,
no screen capture, no API key, no daemon.

```text
claude:tmux-autoname                      Workspace differs from the session name
zsh:partjobs/patent-value-identification  omit-session off
claude:paxc-approx-dnn                    session partjobs, pane in ~/dev/partjobs/paxc-approx-dnn
claude                                    session gig, pane at the session root
ssh:gentoo-box                            remote host as Workspace
```

The name is built from the Activity `A`, the Workspace `W`, and the Area
`R`:

| Workspace | Area | Name |
|---|---|---|
| set | set | `A:W/R` |
| set | empty | `A:W` |
| empty | set | `A:R` |
| empty | empty | `A` |

The Workspace is empty when it equals the session name (see
`@tmux-autoname-omit-session`). The design is recorded in
[docs/adr/0006-rewrite-with-icons.md](docs/adr/0006-rewrite-with-icons.md);
the terms are defined in [CONTEXT.md](CONTEXT.md).

## Why this exists

Earlier versions inferred a task from screen text with an LLM, then
mirrored the title a coding agent sets for itself. Both were dropped:
inferred tasks described the current step, not the goal, and agent titles
changed with pane focus and made windows in one session look the same.
This plugin uses a local, deterministic rule instead.

## Requirements

- tmux 3.3 or newer (CI tests 3.3a, 3.4 and 3.5a)
- POSIX `sh` (the default on Linux and macOS)
- `git`, optional, for the Git Workspace rule
- `zsh`, optional, for the recommended `integrations/tmux-autoname.zsh`
- a [Nerd Font](https://www.nerdfonts.com/), optional, for the icons

No build step and no runtime dependency beyond tmux.

## Install with TPM

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Press `prefix` + <kbd>I</kbd>.

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

The loader always uses `bin/tmux-autoname` of its own checkout, and
exports its path as `TMUX_AUTONAME_BIN` in the tmux global environment for
the zsh integration. To call the commands by name, add the `bin` directory
to `PATH`:

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

## Show the icon

The plugin sets the icon in the window option `@tmux-autoname-icon`. It
never puts the icon into the window name and never edits your status
formats, so add `#{@tmux-autoname-icon}` to both formats yourself:

```tmux
set -g window-status-format         '#I #{@tmux-autoname-icon} #W'
set -g window-status-current-format '#I #{@tmux-autoname-icon} #W'
```

If a theme plugin sets these formats, add the token to the theme's
formats, or set the formats after the theme loads.

## Recommended: the zsh integration

tmux has no hook for a change of the foreground program or of the
directory. Without help, a window is only synced on tmux's own events: a
new window, a pane gaining focus, a split, a killed pane, a pane broken
out to its own window, a new session, a client attaching. If you start `claude` in a shell, or `cd` into another
project, the name and icon do not change until one of those events
occurs.

`integrations/tmux-autoname.zsh` closes that gap. Source it from
`~/.zshrc`:

```sh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

It syncs 0.3 s after a command starts (`preexec`), before each prompt
(`precmd`), and on `cd` (`chpwd`). Each sync runs in the background and is
disowned, so it does not slow the prompt or print job-control messages.
It uses `$TMUX_AUTONAME_BIN`, else `bin/tmux-autoname` of its own
checkout (the shell of a new server's first pane starts before the loader
exports the variable), else `tmux-autoname` on `PATH`.

## Naming rule

All parts come from the window's ACTIVE pane.

- **Activity** is `pane_current_command`: basename, lower-cased, with a
  `-coding-agent` suffix removed (`pi-coding-agent` is `pi`), and only
  `[a-z0-9._+-]` kept; an empty result is `shell`. A launcher (`sudo`,
  `doas`, `env`, `nice`, `timeout`, `systemd-run`, ...) or an interpreter
  (`node`, `bun`, `deno`, `python*`, `ruby`, `perl`) is resolved through
  the foreground process's argv to the program it runs: `doas emerge -a`
  is `emerge`, `node .../bin/codex` is `codex`, `python3 -m http.server`
  is `http.server`. An interpreter with no script (a REPL, `-e`, `-c`)
  keeps its own name. `mosh-client` is `mosh`.
- **Workspace** is the first rule that applies:
  1. **Remote host.** For `ssh` and `mosh`, the remote host, lower-cased.
     It is read from the foreground process's argv: options (and their
     values) are skipped, the first positional is taken, and a `user@`
     prefix, an `ssh://` scheme and a `:port` are removed. For
     `mosh-client`, or when argv gives nothing, the host is parsed from
     the pane title. There is no Area. Without `/proc` (macOS), argv
     comes from `ps`, which joins arguments with spaces, so an argument
     that contains a space (`-o 'Opt value'`) can shift the host.
  2. **Session container.** If the basename of `#{session_path}` equals
     the session name, and the pane path is that directory or under it:
     the session name, with `#{session_path}` as root.
  3. **Git repository.** The basename of `git rev-parse --show-toplevel`,
     with the toplevel as root. In a linked worktree this is the worktree
     directory's name.
  4. **Session name.** The session name, with no root.
- **Area** is the pane path relative to the Workspace root, when the pane
  is strictly under that root. It keeps the first
  `@tmux-autoname-area-depth` path segments (default `1`; `0` keeps the
  full relative path). There is no Area without a root.
- **Omit session.** With `@tmux-autoname-omit-session on` (the default), a
  Workspace equal to the session name is left out: `claude` instead of
  `claude:partjobs`, `zsh:patent-value-identification` instead of
  `zsh:partjobs/patent-value-identification`. Thus `A:x` alone does not
  tell if `x` is a Workspace or an Area.

## Icons

Every `sync` sets `@tmux-autoname-icon` from the Activity, also on a
window with a Manual Name: a Manual Name changes only the name, and the
icon still shows what runs in the window.

The icon is matched against the resolved Activity with sh `case` globs.
The first match wins, in this order:

1. your entries in `@tmux-autoname-icons`,
2. the built-in table below,
3. `@tmux-autoname-icon-default`, by default U+F018D (󰆍).

Because the match uses the resolved Activity, `doas nvim` gets the vim
icon too.

| Patterns | Codepoint | Glyph | Meaning |
|---|---|---|---|
| `nvim*` `vim*` `vi` | U+E62B |  | vim |
| `claude*` | U+EC82 |  | Claude Code |
| `codex*` | U+EC81 |  | Codex (OpenAI) |
| `opencode*` `pi` | U+F06A9 | 󰚩 | other agents |
| `ssh*` `mosh*` | U+F08C0 | 󰣀 | remote |
| `btop*` `htop*` `top` | U+F035B | 󰍛 | system monitor |
| `python*` `ipython*` | U+E606 |  | python |
| `git*` `lazygit*` `tig` | U+F02A2 | 󰊢 | git |
| `yazi*` `lf` `ranger*` | U+F024B | 󰉋 | file manager |
| `man` `less` `bat` | U+F0219 | 󰈙 | pager |
| `zsh*` `bash*` `fish*` `dash*` `sh` `shell` | U+F489 |  | shell |

All glyphs need a Nerd Font. U+EC82 and U+EC81 are the codicons
`claude` and `openai` glyphs, which older Nerd Font releases lack.

`@tmux-autoname-icons` holds whitespace-separated `pattern=icon` pairs,
each split at the first `=`. An icon cannot contain whitespace. Your
entries come before the built-in table, so they can also override it:

```tmux
set -g @tmux-autoname-icons 'emerge=󰏗 python*=X'
set -g @tmux-autoname-icon-default '·'
```

## Commands

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` sets the name and icon of the window that the pane or window
  belongs to, from that window's ACTIVE pane, not from the pane you give.
  The hooks and the zsh integration call it; you seldom need to.
- `auto` forgets a Manual Name and syncs at once.
- `status` prints `name:`, `applied:` (the last name set by `sync`),
  `manual:`, `activity:` and `icon:` lines.

A Manual Name (tmux's own `prefix` + <kbd>,</kbd>, or `rename-window`)
stays until you run `tmux-autoname auto` or rename the window to an empty
string (`tmux rename-window ""`).

## Options

| Option | Default | Meaning |
|---|---|---|
| `@tmux-autoname-area-depth` | `1` | Path segments of the Area to keep; `0` keeps the full relative path |
| `@tmux-autoname-omit-session` | `on` | Leave out a Workspace equal to the session name; `off` keeps it |
| `@tmux-autoname-icons` | empty | Your `pattern=icon` pairs, checked before the built-in table |
| `@tmux-autoname-icon-default` | U+F018D (󰆍) | Icon when no pattern matches |
| `@tmux-autoname-key-auto` | unset | Key in the `prefix` table that runs `auto` on the current window |

Set these before the plugin loads:

```tmux
set -g @tmux-autoname-area-depth 0
set -g @tmux-autoname-key-auto 'M-a'
```

## Optional: tmux-palette

For [tmux-palette](https://github.com/eduwass/tmux-palette),
`integrations/tmux-palette.json` has two items for the `Windows` category:

- **Restore Automatic Window Name** runs `rename-window ''`, which the
  plugin's hook turns into `tmux-autoname auto`.
- **Show Window Name Status** shows the name, the applied name, whether the
  name is manual, and the icon, with a plain `display-message`.

Neither needs the plugin's path. tmux-palette reads user items only from
`~/.config/tmux-palette/commands.json`, so copy the two items into that
array; the plugin does not edit it.

## Upgrading to 1.0

1.0 is a rewrite and does not migrate older installs.

- The separator after the Activity is now always `:`. Pre-1.0 builds
  with omit-session on gave `zsh/src`; 1.0 gives `zsh:src`.
- `@tmux-autoname-omit-session` is `on` by default. Set it to `off` to
  keep the Workspace in every name, as 0.7 always did.
- `@tmux-autoname-bin` is removed. Delete it from your config.
- Add `#{@tmux-autoname-icon}` to your formats (see
  [Show the icon](#show-the-icon)). If your formats had a
  `#{m:...,#W}` table that chose an icon from the window name, remove it.
- The old hooks at index `[120]` are overwritten on load. Options and
  per-window state from older versions stay until the tmux server
  restarts; run `tmux kill-server` once if you want a clean state.

See [CHANGELOG.md](CHANGELOG.md).

## Limits

- Without the zsh integration, the name and icon only update on tmux's own
  window, pane and session events, not on a new foreground command or a
  `cd` in the same pane.
- Only `git` is used for the Workspace; other version-control systems
  fall back to the session-container rule or the session name.
- The remote host is the name given to `ssh` (for example a `Host` alias
  from `~/.ssh/config`), not the resolved `HostName`.

## Development and verification

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` starts real, isolated tmux servers (`tmux -L <name>`) and
drives them with fake processes exec'd under the names it needs, so it
tests the real hooks, not a copy of them. It needs `perl` to set a fake
process's `argv[0]`, and `git` and `zsh` for the tests that use them. CI
runs it under dash with tmux 3.3a, 3.4 and 3.5a.
