# Window Naming

This glossary describes stable work labels for tmux windows. A work label identifies where work belongs and the goal assigned to the Window; current Activity is separate observational information. Decisions behind this language are recorded in `docs/adr/`.

## Language

**Name Record**:
The durable meaning of a Window's accepted automatic name, composed of Scope and Task and independent of its display. An accepted Name Record is informally called the Window's work label. A local name without an accepted Task is a Provisional Name, not a complete Name Record.
_Avoid_: Title, generated string

**Scope**:
The Workspace to which a Window's assigned work belongs. It is distinct from the current directory or tmux Session and need not change when either changes. Subdirectories within a Workspace are not part of Scope.
_Avoid_: Session name, cwd, Area, subdirectory

**Workspace**:
A stable project, worktree, remote environment, or other root that gives work its identity; informally, the project. Its name keeps its original spelling.
_Avoid_: Repository, session

**Task**:
The stable work goal assigned to a Window, broad enough to span investigation, design, implementation, and validation. It describes the Window's purpose rather than its latest command, prompt, output, or active tool. It is written as two to five lower-case English words joined by hyphens.
_Avoid_: Command, prompt, activity, current step

**Window**:
The tmux container to which a work label belongs, potentially including several panes contributing to the same goal. Its work identity is distinct from the focused pane or the lifetime of any one process.
_Avoid_: Pane, agent session

**Activity**:
The currently observed tool or foreground work mechanism, such as `codex`, `nvim`, `pytest`, or `ssh`. Activity is live information derived from Evidence, not part of the Name Record.
_Avoid_: Task, process tree

**Session**:
A tmux collection of windows that provides organizational context. A Session may contain one Workspace, many Workspaces, or only part of one Workspace.
_Avoid_: Project, workspace

**Display Profile**:
A rule that projects a Name Record into a visible window name. Presentation is distinct from the underlying Scope and Task.
_Avoid_: Naming algorithm, task format

**Automatic Name**:
A visible window name produced from a Name Record through a Display Profile.
_Avoid_: AI name

**Provisional Name**:
A Workspace-only window name shown while no Task is accepted. It is a valid name, even indefinitely, when the available Evidence does not establish a work goal.
_Avoid_: Fallback record, empty Task

**Manual Name**:
A user-authored window name that takes precedence over an Automatic Name until automatic naming is explicitly restored.
_Avoid_: Locked automatic name

**Re-identification**:
An explicit request (`tmux-autoname refresh`) to reconsider a Window's assigned work using current Evidence while retaining its accepted work label unless a replacement is accepted.
_Avoid_: Reset, new work

**New Work**:
An explicit end (`tmux-autoname new`) to a Window's previous work assignment, leaving it with a Provisional Name while a new goal is established.
_Avoid_: Reset, refresh, re-identification, restore automation

**Evidence**:
Observed information from which Scope, Task, or Activity may be inferred. Evidence is not itself part of the Name Record.
_Avoid_: Context, name
