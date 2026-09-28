# Mirror agent-generated titles instead of inferring Tasks

Status: Superseded by [ADR 0005](./0005-restore-deterministic-naming.md).
Date: 2026-09-24. Supersedes
[ADR 0001](./0001-stable-window-work-labels.md),
[ADR 0002](./0002-work-label-inference-policy.md), and
[ADR 0003](./0003-work-label-display-and-migration.md) where they conflict.

## Context

The maintainer stopped using automatic naming. Two reasons:

- Tasks inferred from screen text described the current step, not the goal.
  A window whose agent spent hours on a pi TUI module drifted to names like
  `pi-agent:test`. A two-to-five-word slug also could not describe the work.
- The CLI did not work out of the box. TPM clones the repository without
  `dist/`, so every install or update needed `bun install && bun run build`;
  the unbuilt fallback crashed without `node_modules`; and `bin/` was not on
  `PATH`. A tmux plugin that needs a TypeScript toolchain, a build step, and a
  resident daemon is fragile.

Meanwhile the agents already name their own work. Each sets the terminal title
through OSC, and tmux records it as `pane_title`:

| Agent | pane_title | Meaning |
|---|---|---|
| Claude Code | `✳ Worktree review` (glyph animates while busy) | model-generated session title |
| codex | `查看当前工作情况 \| bllc-reproduction` | thread title and project |
| pi | `π - <session name> - <cwd>`, or `π - <cwd>` when unnamed | session name set by `/name` or an extension |

The agent that is doing the work knows its goal. The screen does not.

## Decision

**Task source.** A Window's Task is the title that the agent running in it
reports. The plugin makes no model calls, captures no pane text, and needs no
API key. Titles are natural language (CJK allowed), not slugs.

**Recognised agents.** Only panes whose `pane_current_command` is listed in
`@tmux-autoname-agents` (default `claude codex pi`) contribute titles. Each
has a normaliser: strip the leading status glyph; remove codex's trailing
` | <project>`; extract the session name from pi's title. Placeholder titles
such as `Claude Code`, a bare project name, or an unnamed pi session count as
no title.

**Stability.** The last meaningful title sticks to the Window. It survives
agent exit and is replaced only when an agent in the Window reports a
different meaningful title. When several agent panes share a Window, the
active pane wins. Activity, cwd, focus, and output never change the Task.

**Workspace.** The session-container rule: use the session name when
`#{session_path}`'s basename equals the session name and the pane path is
`session_path` itself or under it. Otherwise use the basename of the main
Git repository, with worktrees mapping to their main repository, and
finally the basename of the directory. The Workspace is fixed once a title
is recorded, and follows the pane path until then.

**Display.** The label is `<workspace>/<title>`, or `<workspace>` when there is
no title. The full label is stored in `@tmux-autoname-label`. The window name
is truncated to `@tmux-autoname-max-width` display cells (default 32) with a
trailing `…`. A picker binding shows full labels through `choose-tree`.

**User control.** User control takes precedence over agent titles:
- `tmux-autoname set <title>` pins a title that agent titles cannot replace.
- `tmux-autoname clear` drops the pin and the sticky title (New Work).
- A user rename is detected when the window name no longer equals the last
  applied name. It is respected until `tmux-autoname auto` or
  `tmux rename-window ""`.
- Optional key bindings prompt for a pin, clear the Window, and open the
  picker.

**Runtime.** The plugin is POSIX `sh` driven by tmux hooks, with no daemon, no
build step, and no dependencies beyond tmux 3.3+ and optionally git. The
`pane-title-changed` hook filters in tmux with a format regex so that spinner
frames do not spawn a shell. `run-shell` runs only when the normalised title
changes.

**pi integration.** An optional pi extension names an unnamed session after
its first turn, using pi's current model, so that pi windows behave like
Claude Code windows.

**Migration.** On load, the plugin stops old daemons, overwrites the old
`[120]` hooks, removes the appended badge fragment and obsolete options, and
leaves Manual Names untouched.

## Consequences

- The TypeScript runtime, daemon, config file, credentials, quotas, badges,
  and eval harness are deleted. ADRs 0001-0003 remain as history. Their
  principles carry over: Manual Name precedence, sticky Task, no replacement
  from activity, and explicit New Work.
- Naming quality now equals the agent's own title quality. A window without a
  recognised agent shows only its Workspace.
- Title changes are decided by the agent. Claude Code keeps its first-topic
  title, which can lag a long session's current focus. `set` or the agent's own
  rename command fixes that.
