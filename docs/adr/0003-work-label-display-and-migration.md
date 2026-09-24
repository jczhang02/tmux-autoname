# Work-label display and migration

Status: Superseded by ADR 0004. Date: 2026-09-23.

## Context

The baseline was SPEC.md v3, which this revises; SPEC.md has since been
updated to match. SPEC.md
defines Scope as Workspace plus an optional Area and displays
`{activity}:{scope}/{task}` by default. This ADR removes Area and Activity
from the durable label and its default display, and defines the one-time
migration of existing accepted labels and templates. It builds on the Name
Record defined in [ADR 0001](./0001-stable-window-work-labels.md).

## Decision

**Area is no longer part of Scope or the Name Record.** Scope is a Workspace
only. cwd-driven subdirectories and Areas are not shown or stored in the
label.

**Default display.** The default display is `{scope}/{task}` (Workspace/Task),
with no Activity and no Area. Live activity does not belong in the durable
label.

**Templates.** Work-label display templates support Scope and Task only.
SPEC.md defines no separate `{area}` template placeholder (Area was only ever
rendered as part of `{scope}`), so no diagnostic is needed for `{area}`. The
old built-in default template migrates automatically to the new default. A
custom template containing `{activity}` is not silently rewritten: it
receives an actionable configuration diagnostic requiring user adjustment,
rather than being dropped or guessed at. Activity remains available in
`explain` diagnostics. A statusline activity component is outside this
change.

**Upgrade migration.** On upgrade, valid existing automatic Tasks become
accepted labels without an AI request. Their existing Workspace affiliation
is retained, with a one-time default-format migration to `{scope}/{task}`
that removes Activity and Area from the stored and displayed label. Manual
names are untouched. Corrupt state or uncertain ownership never justifies
overwriting a visible name by guessing.

**Disclosure.** Release notes, README.md, and README.zh-CN.md must disclose
the one-time display change.

## Consequences

Existing users who relied on Area or Activity appearing in the window name
lose that information from the durable label at upgrade; Activity remains
inspectable through `explain`, but Area is dropped rather than folded into
Task or Workspace.

Custom templates using `{activity}` receive a configuration diagnostic after
upgrade until the user edits them, rather than silently losing the Activity
component; this is a deliberate visibility tradeoff over silent rewriting.

SPEC.md / SPEC.zh-CN.md changes required at implementation:

- Section 4 (Name model): remove `area` from the `Scope` type, remove
  `activity` from `NameRecord`, and change the default Display Profile from
  `{activity}:{scope}/{task}` to `{scope}/{task}`; update the `scope`
  rendering note to drop the `workspace/area` form.
- Section 8 (Scope candidate generation): remove Area candidate
  generation and the Area line from the `partjobs` example.
- Section 2 (Goals): the nested-workspace goal must drop its Area
  wording.
- Section 10 (AI trigger policy): remove "meaningful Area boundary" from
  the trigger list (superseded by
  [ADR 0002](./0002-work-label-inference-policy.md)'s Workspace-only
  trigger).
- Section 11 (AI request and result): remove `areaId` from
  `NameProposalSchema`.
- Release notes, README.md, and README.zh-CN.md: add disclosure of the
  one-time display-format change and the Area removal.
- `tmux-autoname.tmux`: update the seeded `@tmux-autoname-profile` default
  from `{activity}:{scope}/{task}` to `{scope}/{task}`; that tmux option
  takes precedence over the config file default at `src/adapters.ts`
  (~lines 325, 365, 388), so leaving it unchanged would silently keep every
  installed user on the old display format.
- `config/config.example.toml`: update the example `[display] profile`
  value to match the new `{scope}/{task}` default.
