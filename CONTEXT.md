# Window Naming

This glossary describes stable work labels for tmux windows. A work label identifies where work belongs and the goal assigned to the Window. Decisions behind this language are recorded in `docs/adr/`.

## Language

**Name Record**:
The durable meaning of a Window's accepted automatic name, composed of Workspace and Task and independent of its display. An accepted Name Record is informally called the Window's work label. A Name Record without a Task is a Provisional Name.
_Avoid_: Generated string

**Workspace**:
A stable project, worktree, remote environment, or other root that gives work its identity; informally, the project. Computed by the session-container rule, then the main Git repository, then the current directory, and fixed once a Task exists. Its name keeps its original spelling.
_Avoid_: Repository, session, Scope

**Task**:
The title the recognised agent running in a Window reports for its own work, normalised per agent (glyph and placeholder stripped) but otherwise natural language, in whatever language the agent used. It is not inferred, generated, or summarized by this plugin.
_Avoid_: Command, prompt, activity, current step, slug

**Window**:
The tmux container to which a work label belongs, potentially including several panes contributing to the same goal. Its work identity is distinct from the focused pane or the lifetime of any one process. When several agent panes share a Window, the active pane's Task wins.
_Avoid_: Pane, agent session

**Session**:
A tmux collection of windows that provides organizational context. A Session may contain one Workspace, many Workspaces, or only part of one Workspace. Its name participates in the session-container rule.
_Avoid_: Project, workspace

**Automatic Name**:
A visible window name produced from a Name Record: `<workspace>/<task>`, or `<workspace>` alone when there is no Task.
_Avoid_: AI name

**Provisional Name**:
A Workspace-only window name shown while no Task is recorded, either because no recognised agent has reported a meaningful title yet or because `clear` discarded the previous one. It is a valid name, even indefinitely.
_Avoid_: Fallback record, empty Task

**Pin**:
A user-authored Task, set with `tmux-autoname set`, that agent-reported titles cannot replace. `tmux-autoname clear` removes it. Distinct from a Manual Name: a Pin still participates in the `<workspace>/<task>` Automatic Name, while a Manual Name replaces the whole window name.
_Avoid_: Manual Name, override

**Manual Name**:
A user-authored window name, set through tmux's own rename (`prefix` + `,`, or `rename-window`), that takes precedence over the Automatic Name until automatic naming is explicitly restored with `tmux-autoname auto` or `tmux rename-window ""`.
_Avoid_: Locked automatic name, Pin

**New Work**:
An explicit end (`tmux-autoname clear`) to a Window's previous work assignment: drops the Pin, the sticky Task, and the fixed Workspace, leaving a Provisional Name.
_Avoid_: Reset, refresh, restore automation
