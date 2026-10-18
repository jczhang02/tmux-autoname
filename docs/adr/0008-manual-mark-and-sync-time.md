# Manual Mark and sync time

Status: Accepted. Date: 2026-10-18.

## Context

Two gaps showed up in daily use of 2.0:

- A Manual Name stops automatic naming, but nothing on screen says so. The
  window looks automatic and simply stops following its work.
- When syncs stop running (the zsh integration was dead in a new server's
  first pane, see 2.0.0), the name goes stale with no message. `status`
  showed the name, but not whether it was current.

## Decision

### Manual Mark

Each window has the option `@tmux-autoname-manual`: the global
`@tmux-autoname-manual-mark` while the window has a Manual Name, empty
otherwise. Like the Icon, it is never put into the name and the plugin does
not edit status formats; themes show it with
`#{?@tmux-autoname-manual, #{@tmux-autoname-manual},}`.

- The loader sets `@tmux-autoname-manual-mark` to U+F03EB (md-pencil)
  unless the user set it. `show-option -gq` tells an empty value from an
  unset one, so an empty value shows no mark.
- The `after-rename-window[120]` hook sets the mark at once, in tmux
  alone: on a non-empty name it runs
  `set-option -wqF @tmux-autoname-manual '#{?<manual>,<mark>,}'`, where
  `<manual>` is the test `status` and the tmux-palette item already use.
  The command has no `-t`: a target in the hook's `if-shell` branch is not
  format-expanded, and the hook's own target is the renamed window.
- The hook also runs for sync's own `rename-window`, before sync writes
  `@tmux-autoname-applied`, and then marks the window manual. So sync
  clears the mark, inside its guarded write, after every rename it makes
  and whenever it reads a mark on an automatic window. On a manual window
  sync sets the mark when it differs.

### Sync time

Every sync writes the epoch seconds (`date +%s`) to
`@tmux-autoname-synced`, outside the guarded write, so manual windows and
syncs that change nothing record it too. `status` prints
`synced: <n>s ago`, or `synced: never`.

## Consequences

- A sync now always makes one tmux call; before, a sync that changed
  nothing made none.
- Themes must add the mark themselves, as for the Icon.
- A window renamed by hand shows the mark before any sync runs.
