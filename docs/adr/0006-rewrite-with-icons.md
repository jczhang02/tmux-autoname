# Rewrite: per-window Icon, `:` separator, no migration

Status: Superseded by [ADR 0007](./0007-project-and-task-names.md) where
they conflict. Date: 2026-10-17. Supersedes
[ADR 0005](./0005-restore-deterministic-naming.md) where they conflict.

## Context

The maintainer wanted a clean rewrite rather than another increment. Two
concrete changes came out of the design discussion:

- Window icons lived in the maintainer's dotfiles as a `#{m:...,#W}` table in
  `window-status-format`. It matched the start of the window name, so a
  Manual Name lost its icon. The icon must follow what runs in the window,
  whatever the name is.
- With the Workspace omitted, the old name `claude/paxc-approx-dnn` used `/`
  after the Activity. The maintainer wants `:` there too.

Nothing else about the deterministic rule changed. This version does not
keep compatibility with any older install, so all migration code goes.

## Decision

### Name

The Automatic Name is built from Activity `A`, Workspace `W` (after the
omit-session rule below), and Area `R`:

| W | R | Name |
|---|---|---|
| set | set | `A:W/R` |
| set | empty | `A:W` |
| empty | set | `A:R` |
| empty | empty | `A` |

Examples:

- `claude:tmux-autoname` - Workspace differs from the session name.
- `zsh:partjobs/patent-value-identification` - omit-session off.
- `claude:paxc-approx-dnn` - session `partjobs`, omit-session on, pane in
  `~/dev/partjobs/paxc-approx-dnn`.
- `claude` - session `gig`, omit-session on, pane at the session root.
- `ssh:gentoo-box` - remote host as Workspace, no Area.

Accepted consequence: `A:x` alone does not say whether `x` is a Workspace or
an Area.

**Activity** is unchanged from ADR 0005: `pane_current_command`, basename,
lower-cased, `-coding-agent` suffix removed, only `[a-z0-9._+-]` kept, empty
becomes `shell`. A launcher or interpreter is resolved through the foreground
process's argv (the existing `is_wrapper_command`/`foreground_argv`/
`resolve_argv` logic carries over). `mosh-client` is reported as `mosh`.

**Workspace**, first that applies:

1. `ssh`/`mosh`: the remote host, lower-cased, read from the foreground
   process's argv: skip options (and the value of options that take one;
   for ssh: `-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W
   -w`), take the first positional, strip a `user@` prefix and an
   `ssh://` scheme and any `:port`. For `mosh-client`, whose argv is not
   the user's, and whenever argv gives nothing, fall back to parsing
   `pane_title` (the ADR 0005 `remote_host_from_title`). No Area.
2. Session container: `basename(session_path) == session_name` and the pane
   path is `session_path` or under it: the session name, root `session_path`.
3. `git rev-parse --show-toplevel` basename, root the toplevel. In a linked
   worktree this is the worktree directory's name, on purpose.
4. The session name, no root.

**Area** is the pane path relative to the Workspace root, when strictly under
it, capped to the first `@tmux-autoname-area-depth` segments (default `1`,
`0` = unlimited).

**Omit session.** `@tmux-autoname-omit-session` now defaults to `on`: a
Workspace equal to the session name is left out. `off` keeps it.

### Icon

Each window gets a window option `@tmux-autoname-icon`, a single glyph
chosen from the Activity. The plugin never puts the icon into the window
name; themes show it with `#{@tmux-autoname-icon}` in
`window-status-format` / `window-status-current-format`.

**`sync` sets the icon on every window, including a window with a Manual
Name.** A Manual Name changes only the name; the icon keeps following the
Activity. For a manual window `sync` computes the Activity (with the same
`tmux` retry and argv resolution) and sets the icon, then stops without
touching the name and without running git.

Matching is against the resolved Activity, with sh `case` globs, first
match wins, in this order:

1. User entries from `@tmux-autoname-icons`: whitespace-separated
   `pattern=icon` pairs, split at the first `=`. Example:
   `set -g @tmux-autoname-icons 'emerge=󰏗 python*=X'`.
2. The built-in table below.
3. `@tmux-autoname-icon-default`, default U+F018D (󰆍).

Built-in table (Nerd Font codepoints; the script stores them as literal
UTF-8, and tests compare against bytes built with `printf` octal escapes):

| Patterns | Codepoint | Meaning |
|---|---|---|
| `nvim*` `vim*` `vi` | U+E62B | vim |
| `claude*` | U+EC82 (codicons `claude`) | Claude Code |
| `codex*` | U+EC81 (codicons `openai`) | Codex |
| `opencode*` `pi` | U+F06A9 | other agents |
| `ssh*` `mosh*` | U+F08C0 | remote |
| `btop*` `htop*` `top` | U+F035B | system monitor |
| `python*` `ipython*` | U+E606 | python |
| `git*` `lazygit*` `tig` | U+F02A2 | git |
| `yazi*` `lf` `ranger*` | U+F024B | file manager |
| `man` `less` `bat` | U+F0219 | pager |
| `zsh*` `bash*` `fish*` `dash*` `sh` `shell` | U+F489 | shell |

The table was taken from the maintainer's dotfiles; the old `vi:*`, `pi:*`
and `sh:*` entries matched the window name and become plain `vi`, `pi`, `sh`.

### Manual Name

Unchanged mechanism: after each automatic rename, `sync` records the name in
`@tmux-autoname-applied`, read back as `#{window_name}` because tmux expands
`#` in `rename-window` and escapes some bytes when it stores a name. If the
window's current name differs from it, the name is manual and `sync` leaves
it. `tmux-autoname auto` or
`rename-window ""` (via the `after-rename-window` hook, guarded by
`if-shell -F '#{==:#{window_name},}'`) clears it and re-syncs.

`sync` writes the name through `if-shell -F`, which checks inside the server
that the name and `@tmux-autoname-applied` are still what `sync` read. A
rename made while a sync runs is therefore never overwritten. When the check
fails but the window is still automatic (another sync wrote first, maybe from
older data), `sync` reads again and retries, up to 3 times. The computed name
is kept in `@tmux-autoname-computed`, so a name that tmux stores escaped
(`\\` for `\`) is not renamed again on every sync.

### Commands

- `sync [-t pane_or_window]` - name and icon from the window's ACTIVE pane.
- `auto [-t window]` - forget the Manual Name and sync.
- `status [-t window]` - print `name:`, `applied:`, `manual:`, `activity:`,
  `icon:` lines.
- `help`.

### Options

| Option | Default |
|---|---|
| `@tmux-autoname-area-depth` | `1` |
| `@tmux-autoname-omit-session` | `on` |
| `@tmux-autoname-icons` | empty |
| `@tmux-autoname-icon-default` | U+F018D |
| `@tmux-autoname-key-auto` | unset |

`@tmux-autoname-bin` is removed: the loader always uses `bin/tmux-autoname`
of its own checkout and exports it as `TMUX_AUTONAME_BIN` in the global
environment for the zsh integration. The integration falls back to the
`bin/tmux-autoname` of its own checkout, because the shell of a new
server's first pane starts before the loader runs.

### Runtime

POSIX `sh`, tmux hooks, no daemon, no build. Hooks at index `[120]`:
`after-new-window`, `after-select-window`, `window-pane-changed`,
`after-split-window`, `client-attached`, `session-created`,
`after-kill-pane`, `window-linked` (for `break-pane`, which has no `after-`
hook; all `run-shell -b "<bin> sync -t '#{window_id}'"`), and the guarded
`after-rename-window`. The loader syncs every window at the end,
with `##{window_id}` double-hashed inside `run-shell`.

`integrations/tmux-autoname.zsh` stays: sync 0.3 s after `preexec`, and at
`precmd` and `chpwd`, all backgrounded with `&!`. `precmd` kills a delayed
sync that has not run yet, so it can't land after the prompt's sync.

Performance: read all pane/window fields in one `tmux display-message -p`
call, one field per line (tmux 3.4 prints a control-character separator as
text); read argv from `/proc` on Linux and `ps` elsewhere; call
`rename-window` / `set-option` only when the value changes.

### Behaviours carried over from 0.7

- Retry while `pane_current_command` is empty or `tmux` (fresh pane race),
  up to 10 x 50 ms.
- Always name from the window's active pane, never the pane passed in.
- `after-kill-pane` syncs by `#{window_id}`.
- Test fixtures commit with `git -c core.hooksPath=/dev/null` and a
  Conventional message, so a global commit-msg hook can't break the suite.

### Removed

All migration from 0.5, 0.6 and the pre-0.6 daemon (pid cleanup, badge
fragment removal, obsolete options, per-window state), and
`@tmux-autoname-bin`.

## Consequences

- Themes must add `#{@tmux-autoname-icon}` themselves; the plugin does not
  edit `window-status-format`.
- A Manual Name keeps a correct icon.
- Installs older than 1.0 are not cleaned up; old hooks at index `[120]` are
  overwritten, old options stay until the server restarts.
