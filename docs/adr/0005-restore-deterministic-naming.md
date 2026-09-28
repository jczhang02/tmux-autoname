# Restore the original deterministic naming, without AI

Status: Accepted. Date: 2026-09-27. Supersedes
[ADR 0004](./0004-mirror-agent-titles.md).

## Context

ADR 0004 replaced inferred Tasks with titles that agents report about
themselves. In real use this did not hold up:

- Agent titles are mostly Chinese, and window names must not be.
- A window's name matters for every program, not only for agents.
- Titles changed with pane focus when one Window held several agents.
- Dropping the Area made windows of one sesh session indistinguishable.

The maintainer also tried `joshmedeski/tmux-nerd-font-window-name` and found
it worse than the names they had been using every day before, for example
`codex:partjobs/bllc-reproduction` and `zsh:partjobs/patent-value-identification`.
Those names came from the local, non-AI part of the 0.4/0.5 naming.

## Decision

**Naming rule.** The window name is `<activity>:<workspace>[/<area>]`. This
is the 0.4 rule with the Task always empty.

- **Activity** is the foreground program of the active pane. It is
  lower-cased and a `-coding-agent` suffix is removed.
- **Workspace** is the first of these that applies:
  1. For `ssh` or `mosh`, the remote host parsed from the pane title.
  2. The session container: when the basename of `session_path` equals the
     session name and the pane path is at or under `session_path`, use the
     session name.
  3. The basename of `git rev-parse --show-toplevel`.
  4. The session name.
- **Area** is the pane path relative to the chosen Workspace's root. It is
  omitted when the path is the root itself or lies outside it. It is
  additionally capped to its first `@tmux-autoname-area-depth` path segments
  (default 1; 0 keeps it in full). The depth limit is an addition to the
  original 0.4 rule, adopted during this port to keep names short.

**No AI.** No model calls, no API keys, no screen capture, and no
agent-title mirroring. Everything from ADR 0004 that depended on agent titles
is removed: Pin, sticky title, prefill, and the pi extension.

**Kept from the sh implementation.** POSIX `sh` driven by tmux hooks, with no
daemon and no build. A Manual Name takes precedence and is restored with
`auto` or `rename-window ""`. Migration from 0.5 is kept.

**Triggers.** tmux hooks cover window, pane, and session changes. An optional
zsh integration also syncs when a command starts or finishes and on `cd`,
because tmux has no hook for foreground-program or cwd changes.

## Consequences

- Names match what the maintainer used daily, minus the AI Task.
- Without the zsh integration, the activity updates only on window, pane, and
  session events.
- Further improvements are optional additions on top of this rule. The first
  one: Activity resolves launchers (`sudo`, `doas`, `env`, ...) and
  interpreters (`node`, `python*`, ...) through the foreground process's
  argv, so `node .../codex` is `codex` and `doas emerge` is `emerge`.
