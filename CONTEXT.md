# Window Naming

This context describes the semantic information used to name tmux windows. A name identifies where work belongs, why it is being done, and how it is currently being performed without tying those meanings to one display habit.

## Language

**Name Record**:
The structured meaning of an accepted automatic window name, composed of Scope, Task, and Activity. It is independent of how the name is displayed. A local name without an accepted Task is a Provisional Name, not a complete Name Record.
_Avoid_: Title, generated string

**Scope**:
The meaningful location to which work belongs, composed of a Workspace and an optional Area. A Scope is not assumed to be the tmux Session or raw current directory.
_Avoid_: Session name, cwd

**Workspace**:
A stable project, worktree, remote environment, or other root that gives work its identity.
_Avoid_: Repository, session

**Area**:
A meaningful sublocation within a Workspace, such as `code`, `manuscript`, or `docs`.
_Avoid_: Subdirectory, path suffix

**Task**:
The stable user goal currently being pursued within a Scope. A Task describes intent rather than the latest command, output, or tool.
It is stored as two to five lower-case English words joined by hyphens.
_Avoid_: Command, prompt, activity

**Activity**:
The tool or foreground work mechanism currently used to pursue a Task, such as `codex`, `nvim`, `pytest`, or `ssh`.
_Avoid_: Task, process tree

**Session**:
A tmux collection of windows that provides organizational context. A Session may contain one Workspace, many Workspaces, or only part of one Workspace.
_Avoid_: Project, workspace

**Display Profile**:
A rule that projects a Name Record into a visible window name. Changing the Display Profile does not change Scope, Task, or Activity.
_Avoid_: Naming algorithm, task format

**Automatic Name**:
A visible window name produced from a Name Record through a Display Profile.
_Avoid_: AI name

**Provisional Name**:
A useful local window name rendered from Scope and Activity while no accepted Task is available. It remains usable during startup and AI failure but does not claim to be a complete Name Record.
_Avoid_: Fallback record, empty Task

**Manual Name**:
A user-authored window name that takes precedence over an Automatic Name until automatic naming is explicitly restored.
_Avoid_: Locked automatic name

**Evidence**:
Observed information from which Scope, Task, or Activity may be inferred. Evidence is not itself part of the Name Record.
_Avoid_: Context, name
