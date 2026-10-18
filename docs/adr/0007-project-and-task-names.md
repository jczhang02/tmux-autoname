# Project and Task names, Activity only in the Icon

Status: Accepted. Date: 2026-10-17. Supersedes
[ADR 0006](./0006-rewrite-with-icons.md) where they conflict.

## Context

The 1.0 name `A:W/R` answers "what program runs, in which project and
directory". In daily use the maintainer needs a different answer. Their
habits, collected in the design discussion:

- One ghostty per GNOME workspace, one tmux session per ghostty.
- One session works in one large directory: a single project
  (`tmux-autoname`) or a directory of projects (`partjobs`).
- Three to four windows per session. Windows are found by their name in the
  status bar, then selected with the mouse or a number key.
- One window does one task in one project and is killed (`prefix q`) when
  the task is done.
- A window is often split: an agent in one pane, a shell in the other.
- Agents create the task branches and worktrees themselves, then merge them
  back to `main`.
- Windows are sometimes named by hand with `prefix ,`.

From these, the name must say, in this order:

1. the task the window does,
2. the project, when the session does not already say it.

The program is not part of the name. The Icon shows it, and two panes of
one window (agent and shell) are in the same project and on the same
branch, so the name no longer changes when the focus moves between them.

Problems with the 1.0 name that this fixes:

- An agent started at the session root showed only `claude`.
- The Area named a directory (`manuscript`), not the task.
- In a session container, a worktree such as
  `paxc-approx-dnn/.claude/worktrees/report-clarity` was named after the
  project only; the worktree was lost.

Measured facts that the decision relies on:

- Claude Code changes its own process cwd when it enters a worktree
  (EnterWorktree, or `claude -w`), so `pane_current_path` follows it.
- A `cd` in Claude Code's Bash tool does not change the process cwd.
- A branch is the only task signal that needs no input. Two windows on
  the same branch in the same directory can't be told apart by any local
  fact; the maintainer names one of them by hand.

## Decision

### Name

The Automatic Name is built from the Project `P` and the Task `T` of the
window's active pane. `P` is left out when it equals the session name.

| P differs from the session name | T set | Name |
|---|---|---|
| yes | yes | `P/T` |
| yes | no | `P` |
| no | yes | `T` |
| no | no | the branch, else the directory name |

The last row needs a fallback because both parts are empty: the current
branch (`main`), or, outside a Git repository or on a detached HEAD, the
basename of the pane path (`~` for the home directory).

Examples:

| Session | Pane | Name |
|---|---|---|
| `tmux-autoname` | repository root or `bin/`, on `main` | `main` |
| `partjobs` | `patent-value-identification/manuscript`, on `main` | `patent-value-identification` |
| `partjobs` | `patent-value-identification`, on `ch4-selector-improvement` | `patent-value-identification/ch4-selector-improvement` |
| `partjobs` | worktree `paxc-approx-dnn/.claude/worktrees/report-clarity` | `paxc-approx-dnn/report-clarity` |
| `paxc-approx-dnn` | the same worktree | `report-clarity` |
| `partjobs` | the session root `~/dev/partjobs`, no Git | `partjobs` |
| `main` (path `~`) | `~/Downloads`, no Git | `Downloads` |
| any | `ssh gentoo-box` | `gentoo-box` |

**Project**, first that applies:

1. `ssh`/`mosh`: the remote host, parsed as in ADR 0006. The name is the
   host alone; there is no Task.
2. In a Git repository: the basename of `--show-toplevel`. In a linked
   worktree of an ordinary repository (`--git-dir` differs from
   `--git-common-dir`, and the common dir is a `.git` directory) it is the
   basename of the repository that holds that `.git`, so the worktree maps
   to its main repository. A submodule's common dir is
   `<super>/.git/modules/<sub>` and a bare repository's is the repository
   itself; neither is a `.git`, so a submodule and the worktrees of either
   keep their own toplevel names. The three paths come from one
   `git rev-parse --path-format=absolute` call. Git older than 2.31 prints
   that option back instead of a path; this counts as no Git.
3. Not in Git, the pane strictly under a session container
   (`basename(session_path) == session_name`): the first path segment below
   `session_path`.
4. Otherwise: the session name, which is then left out.

**Task** is the current branch, also one with no commit yet, unless it is
`main` or `master` or HEAD is detached. It is read with
`git symbolic-ref -q HEAD`, without `--short`, which would add `heads/`
when a tag has the same name. A leading `worktree-` (the prefix Claude Code
gives worktree branches) is removed when something follows it. The rest of
the branch name is kept as it is.

There is no other Task source. The maintainer's own `prefix ,` stays as the
way to name a window by hand: a Manual Name replaces the whole name, and the
binding is not changed.

**Activity** is still computed exactly as in ADR 0006. It chooses the Icon
and is printed by `status`, but it is never part of the name.

### Icon

The Icon is now the only place that shows the program, so the built-in
table grows to cover the programs that stay in the foreground in the
maintainer's shell history (last 180 days) and common programs of the same
kind. Matching order is unchanged: `@tmux-autoname-icons`, then this table,
then `@tmux-autoname-icon-default` (U+F018D).

| Patterns | Codepoint | Meaning |
|---|---|---|
| `nvim*` `vim*` `vi` | U+E62B | vim |
| `claude*` | U+EC82 | Claude Code |
| `codex*` | U+EC81 | Codex |
| `opencode*` `pi` `gemini*` `aider*` `crush*` `goose*` `amp` | U+F06A9 | other agents |
| `ssh*` `mosh*` `scp` `sftp` `rsync` | U+F08C0 | remote |
| `btop*` `htop*` `top` `nvtop` `nvidia-smi` `watch` | U+F035B | system monitor |
| `python*` `ipython*` `uv` `pip*` `pdm` `conda` `mamba` `jupyter*` | U+E606 | python |
| `git*` `lazygit*` `tig` | U+F02A2 | git |
| `gh` | U+F02A4 | GitHub |
| `yazi*` `lf` `ranger*` | U+F024B | file manager |
| `man` `less` `bat` `more` `tail` `journalctl` `dmesg` | U+F0219 | pager and logs |
| `emerge` `eix*` `equery` `eselect` `euse` `emaint` | U+F30D | Gentoo |
| `flatpak` `mise` `pacman` `paru` `yay` `apt*` `dnf` `brew` | U+F03D7 | package manager |
| `node*` `npm*` `npx*` `pnpm*` `bun*` `deno` `yarn*` | U+F0399 | Node and JS |
| `cargo` `rustc` | U+F1617 | Rust |
| `go` | U+F07D3 | Go |
| `docker*` `podman*` `lxc` `incus` | U+F0868 | container |
| `kubectl` `k9s` | U+F10FE | Kubernetes |
| `make` `cmake` `ninja` `meson` `just` `gcc` `clang` `cc` | U+F08EA | build |
| `curl` `wget` `aria2c` `ping` `mtr` `dig` `nslookup` `cloudflared` | U+F059F | network |
| `sqlite3` `psql` `mysql` `redis-cli` `duckdb` | U+F01BC | database |
| `systemctl` | U+F0493 | system service |
| `tmux` `sesh` | U+EBC8 | tmux |
| `latexmk` `tectonic` `xelatex` `pdflatex` `lualatex` `typst` | U+E81F | LaTeX and Typst |
| `zathura` | U+F0226 | PDF |
| `typora` `pandoc` | U+E73E | Markdown |
| `ffmpeg` `yt-dlp` `mpv` | U+F0381 | audio and video |
| `emacs*` | U+E632 | Emacs |
| `nano` `micro` `hx` `helix` | U+F0DC8 | other editors |
| `zsh*` `bash*` `fish*` `dash*` `sh` `shell` | U+F489 | shell |

Node CLIs are matched by the name that argv resolution gives them
(`npm-cli`, `npx-cli`, `pnpm`), hence the `*` patterns.

### Unchanged

Manual Name detection and restoring (`auto`, `rename-window ""`), the
race-safe write through `if-shell -F`, naming from the window's active
pane, the hooks, the zsh integration, `@tmux-autoname-icons`,
`@tmux-autoname-icon-default` and `@tmux-autoname-key-auto`.

`status` keeps its lines and adds `project:` and `task:`.

### Removed

- `@tmux-autoname-area-depth`: there is no Area.
- `@tmux-autoname-omit-session`: leaving out a Project equal to the session
  name is now part of the rule.

## Consequences

- Breaking change; released as 2.0.0.
- Names are short and say what the window is for. The program shows only as
  the Icon, so a program missing from the table shows the default Icon;
  `status` prints its Activity for a `@tmux-autoname-icons` entry.
- Subdirectories no longer appear in names. Two windows in one project on
  one branch get the same name until one is named by hand.
- A branch switch or a worktree entered by a running agent is picked up on
  the next tmux event (window or pane change) or when the program exits,
  not at once: no hook fires while the agent runs.
- Each sync of an automatic window runs `git rev-parse`, also in a session
  container, where 1.0 ran no Git; inside a repository it also runs
  `git symbolic-ref`.
- The Git rules need Git 2.31 or newer; older Git falls back to the rules
  for a directory outside Git.
