# Window Naming

This glossary describes the deterministic name tmux-autoname gives a
window. Decisions behind this language are recorded in `docs/adr/`.

## Language

**Name Record**:
The durable meaning of a Window's accepted automatic name, composed of a
Project, an optional Task, and a Fallback.
_Avoid_: Generated string

**Project**:
The project a Window works in: the `ssh`/`mosh` remote host, else the main
Git repository (a linked worktree maps to its main repository), else the
directory below a session container, else the session name. Its name keeps
its original spelling.
_Avoid_: Repository, session, Workspace, Scope

**Task**:
The work a Window does: the current branch, also one with no commit yet,
unless it is `main` or `master` or HEAD is detached, with a leading
`worktree-` removed when something follows it. There is no other source; a
task without a branch is named by hand.
_Avoid_: Area, subdirectory, inferred task, agent title

**Fallback**:
The name used when the Project is omitted and there is no Task: the remote
host, else the current branch (`main`), else the directory name (`~` for the
home directory).
_Avoid_: Default name

**Omitted Project**:
A Project equal to the session name is left out of the rendered name, which
becomes the Task alone. The Name Record is the same; only its rendering is
shorter.
_Avoid_: Hidden session, short name

**Automatic Name**:
The visible window name computed from a Name Record: `<project>/<task>`,
`<project>`, or, with an Omitted Project, `<task>`, else the Fallback.
Never contains the program.
_Avoid_: AI name

**Activity**:
The foreground program of a Window's active pane: `pane_current_command`,
lower-cased, with a `-coding-agent` suffix removed, and resolved through
launchers and interpreters to the program they run (`doas emerge` is
`emerge`, `node .../codex` is `codex`). It chooses the Icon and is not part
of the name.
_Avoid_: Command, task, current step

**Icon**:
A single glyph chosen from a Window's Activity and stored in the window option
`@tmux-autoname-icon`, never in the window name. It is the only place that
shows the program. It is set on every sync, also for a Window with a Manual
Name, so it always shows what runs there.
_Avoid_: Badge, emoji

**Window**:
The tmux container to which a Name Record belongs. Its Project, Task, and
Activity are always computed from its currently ACTIVE pane, not any
background pane that happens to trigger a `sync`.
_Avoid_: Pane, agent session

**Session**:
A tmux collection of windows that provides organizational context. A
Session may contain one Project or a directory of Projects. Its name
participates in the session-container rule and the Omitted Project.
_Avoid_: Project, workspace

**Manual Mark**:
A single glyph in the window option `@tmux-autoname-manual` while a Window
has a Manual Name, empty otherwise. tmux's rename hook sets it at once;
sync keeps it right. Like the Icon, it is never part of the name.
_Avoid_: Lock, pin badge

**Manual Name**:
A user-authored window name, set through tmux's own rename (`prefix` + `,`,
or `rename-window`), that takes precedence over the Automatic Name until
automatic naming is explicitly restored with `tmux-autoname auto` or `tmux
rename-window ""`.
_Avoid_: Locked automatic name, Pin
