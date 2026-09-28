# Window Naming

This glossary describes the deterministic name tmux-autoname gives a
window. Decisions behind this language are recorded in `docs/adr/`.

## Language

**Name Record**:
The durable meaning of a Window's accepted automatic name, composed of
Activity, Workspace, and an optional Area.
_Avoid_: Generated string

**Activity**:
The foreground program of a Window's active pane: `pane_current_command`,
lower-cased, with a `-coding-agent` suffix removed. It is a fact about what
is currently running, not a description of the work.
_Avoid_: Command, task, current step

**Workspace**:
A stable project, worktree, remote environment, or other root that gives
work its identity; informally, the project. Computed by the `ssh`/`mosh`
remote-host rule, then the session-container rule, then the main Git
repository, then the session name itself. Its name keeps its original
spelling.
_Avoid_: Repository, session, Scope, Task

**Area**:
The active pane's path relative to the Workspace's root, when the pane is
strictly under that root. Capped to its first `@tmux-autoname-area-depth`
path segments (default 1); it is omitted entirely when there is no root to
measure against, or the pane's path is the root itself.
_Avoid_: Subdirectory, path, slug

**Window**:
The tmux container to which a Name Record belongs. Its Activity, Workspace,
and Area are always computed from its currently ACTIVE pane, not any
background pane that happens to trigger a `sync`.
_Avoid_: Pane, agent session

**Session**:
A tmux collection of windows that provides organizational context. A
Session may contain one Workspace, many Workspaces, or only part of one
Workspace. Its name participates in the session-container rule.
_Avoid_: Project, workspace

**Automatic Name**:
The visible window name computed from a Name Record: `<activity>:<workspace>`,
or `<activity>:<workspace>/<area>` when there is an Area.
_Avoid_: AI name

**Manual Name**:
A user-authored window name, set through tmux's own rename (`prefix` + `,`,
or `rename-window`), that takes precedence over the Automatic Name until
automatic naming is explicitly restored with `tmux-autoname auto` or `tmux
rename-window ""`.
_Avoid_: Locked automatic name, Pin
