# tmux-autoname

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname names tmux windows deterministically after the project and
the task they work on, and gives each window an icon for the program that
runs in it. No model calls, no screen capture, no API key, no daemon.

```text
patent-value-identification                           session partjobs, on main
patent-value-identification/ch4-selector-improvement  session partjobs, on branch ch4-selector-improvement
paxc-approx-dnn/report-clarity                        session partjobs, worktree report-clarity
ch4-selector-improvement                              session patent-value-identification
main                                                  session tmux-autoname, on main
gentoo-box                                            ssh gentoo-box
```

The name is built from the Project `P` and the Task `T`. The Task is the
current branch, unless it is `main` or `master`:

| P differs from the session name | Task | Name |
|---|---|---|
| yes | set | `P/T` |
| yes | none | `P` |
| no | set | `T` |
| no | none | the branch, else the directory name |

The program is not part of the name; the icon shows it. The design is
recorded in
[docs/adr/0007-project-and-task-names.md](docs/adr/0007-project-and-task-names.md);
the terms are defined in [CONTEXT.md](CONTEXT.md).

## Why this exists

Earlier versions inferred a task from screen text with an LLM, then
mirrored the title a coding agent sets for itself. Both were dropped:
inferred tasks described the current step, not the goal, and agent titles
changed with pane focus and made windows in one session look the same.
This plugin uses a local, deterministic rule instead. A window usually does
one task in one project, and the task usually has its own branch, so the
name says those two things.

## Requirements

- tmux 3.3 or newer (CI tests 3.3a, 3.4 and 3.5a)
- POSIX `sh` (the default on Linux and macOS)
- `git` 2.31 or newer, optional, for the Project and the Task; older Git
  is treated as no Git
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

- **Project** is the first that applies:
  1. **Remote host.** For `ssh` and `mosh`, the remote host, lower-cased.
     The name is the host alone. It is read from the foreground process's
     argv: options (and their values) are skipped, the first positional is
     taken, and a `user@` prefix, an `ssh://` scheme and a `:port` are
     removed. For `mosh-client`, or when argv gives nothing, the host is
     parsed from the pane title. Without `/proc` (macOS), argv comes from
     `ps`, which joins arguments with spaces, so an argument that contains
     a space (`-o 'Opt value'`) can shift the host.
  2. **Git repository.** The basename of `git rev-parse --show-toplevel`.
     A linked worktree is named after its main repository: a worktree in
     `paxc-approx-dnn/.claude/worktrees/report-clarity` has the Project
     `paxc-approx-dnn`. A submodule keeps its own name.
  3. **Session container.** Outside Git, if the basename of
     `#{session_path}` equals the session name and the pane path is under
     that directory: the first directory below it.
  4. **Session name.**
- **Task** is the current branch, unless it is `main` or `master` or HEAD
  is detached. A leading `worktree-`, the prefix Claude Code gives
  worktree branches, is removed.
- A Project equal to the session name is left out. With neither Project
  nor Task, the name is the current branch (`main`), or, outside Git, the
  directory name (`~` for the home directory).
- Subdirectories are not part of the name. Two windows in one project on
  one branch have the same name; name one of them by hand
  (`prefix` + <kbd>,</kbd>).
- **Activity** is the program that runs, used for the icon and printed by
  `status`: `pane_current_command`, basename, lower-cased, with a
  `-coding-agent` suffix removed (`pi-coding-agent` is `pi`), and only
  `[a-z0-9._+-]` kept; an empty result is `shell`. A launcher (`sudo`,
  `doas`, `env`, `nice`, `timeout`, `systemd-run`, ...) or an interpreter
  (`node`, `bun`, `deno`, `python*`, `ruby`, `perl`) is resolved through
  the foreground process's argv to the program it runs: `doas emerge -a`
  is `emerge`, `node .../bin/codex` is `codex`, `python3 -m http.server`
  is `http.server`. An interpreter with no script (a REPL, `-e`, `-c`)
  keeps its own name. `mosh-client` is `mosh`.

## Icons

Every `sync` sets `@tmux-autoname-icon` from the Activity, also on a
window with a Manual Name: a Manual Name changes only the name, and the
icon still shows what runs in the window. The icon is the only place that
shows the program, so the built-in table covers many programs.

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
| `opencode*` `pi` `gemini*` `aider*` `crush*` `goose*` `amp` | U+F06A9 | 󰚩 | other agents |
| `ssh*` `mosh*` `scp` `sftp` `rsync` | U+F08C0 | 󰣀 | remote |
| `btop*` `htop*` `top` `nvtop` `nvidia-smi` `watch` | U+F035B | 󰍛 | system monitor |
| `python*` `ipython*` `uv` `pip*` `pdm` `conda` `mamba` `jupyter*` | U+E606 |  | python |
| `git*` `lazygit*` `tig` | U+F02A2 | 󰊢 | git |
| `gh` | U+F02A4 | 󰊤 | GitHub |
| `yazi*` `lf` `ranger*` | U+F024B | 󰉋 | file manager |
| `man` `less` `bat` `more` `tail` `journalctl` `dmesg` | U+F0219 | 󰈙 | pager and logs |
| `emerge` `eix*` `equery` `eselect` `euse` `emaint` | U+F30D |  | Gentoo |
| `flatpak` `mise` `pacman` `paru` `yay` `apt*` `dnf` `brew` | U+F03D7 | 󰏗 | package manager |
| `node*` `npm*` `npx*` `pnpm*` `bun*` `deno` `yarn*` | U+F0399 | 󰎙 | Node and JS |
| `cargo` `rustc` | U+F1617 | 󱘗 | Rust |
| `go` | U+F07D3 | 󰟓 | Go |
| `docker*` `podman*` `lxc` `incus` | U+F0868 | 󰡨 | container |
| `kubectl` `k9s` | U+F10FE | 󱃾 | Kubernetes |
| `make` `cmake` `ninja` `meson` `just` `gcc` `clang` `cc` | U+F08EA | 󰣪 | build |
| `curl` `wget` `aria2c` `ping` `mtr` `dig` `nslookup` `cloudflared` | U+F059F | 󰖟 | network |
| `sqlite3` `psql` `mysql` `redis-cli` `duckdb` | U+F01BC | 󰆼 | database |
| `systemctl` | U+F0493 | 󰒓 | system service |
| `tmux` `sesh` | U+EBC8 |  | tmux |
| `latexmk` `tectonic` `xelatex` `pdflatex` `lualatex` `typst` | U+E81F |  | LaTeX and Typst |
| `zathura` | U+F0226 | 󰈦 | PDF |
| `typora` `pandoc` | U+E73E |  | Markdown |
| `ffmpeg` `yt-dlp` `mpv` | U+F0381 | 󰎁 | audio and video |
| `emacs*` | U+E632 |  | Emacs |
| `nano` `micro` `hx` `helix` | U+F0DC8 | 󰷈 | other editors |
| `zsh*` `bash*` `fish*` `dash*` `sh` `shell` | U+F489 |  | shell |

All glyphs need a Nerd Font. U+EC82 and U+EC81 are the codicons
`claude` and `openai` glyphs, which older Nerd Font releases lack. A
program that no pattern matches gets the default icon; `tmux-autoname
status` prints its Activity, which you can add to `@tmux-autoname-icons`.

`@tmux-autoname-icons` holds whitespace-separated `pattern=icon` pairs,
each split at the first `=`. An icon cannot contain whitespace. Your
entries come before the built-in table, so they can also override it:

```tmux
set -g @tmux-autoname-icons 'frob*=󰏗 python*=X'
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
  `manual:`, `activity:`, `icon:`, `project:` and `task:` lines.

A Manual Name (tmux's own `prefix` + <kbd>,</kbd>, or `rename-window`)
stays until you run `tmux-autoname auto` or rename the window to an empty
string (`tmux rename-window ""`).

## Options

| Option | Default | Meaning |
|---|---|---|
| `@tmux-autoname-icons` | empty | Your `pattern=icon` pairs, checked before the built-in table |
| `@tmux-autoname-icon-default` | U+F018D (󰆍) | Icon when no pattern matches |
| `@tmux-autoname-key-auto` | unset | Key in the `prefix` table that runs `auto` on the current window |

Set these before the plugin loads:

```tmux
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

## Upgrading to 2.0

2.0 changes what a name says (see
[ADR 0007](docs/adr/0007-project-and-task-names.md)).

- Names no longer start with the program: `claude:paxc-approx-dnn` is now
  `paxc-approx-dnn`. The icon shows the program.
- A branch other than `main` or `master` is the Task:
  `patent-value-identification/ch4-selector-improvement`.
- Subdirectories are no longer part of the name.
- `@tmux-autoname-area-depth` and `@tmux-autoname-omit-session` are
  removed. Delete them from your config.
- If your status format shows `#W`, a long `P/T` name can be cut there
  with `#{=/24/…:window_name}`.

## Upgrading to 1.0

1.0 is a rewrite and does not migrate older installs.

- The separator after the Activity is now always `:`. Pre-1.0 builds
  with omit-session on gave `zsh/src`; 1.0 gives `zsh:src`.
- `@tmux-autoname-omit-session` is `on` by default. Set it to `off` to
  keep the Workspace in every name, as 0.7 always did. (Removed in 2.0.)
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
- Only `git` is used for the Project and the Task; other version-control
  systems fall back to the session-container rule or the session name.
- A program that switches the branch or enters a worktree while it runs
  (a coding agent, for example) changes the name only at the next tmux
  event (a window or pane change) or when it exits. No hook fires while
  it runs.
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
