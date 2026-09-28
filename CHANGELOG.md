# Changelog

## Unreleased

- Activity resolves launchers (`sudo`, `doas`, `env`, `nice`, `timeout`,
  `systemd-run`, ...) and interpreters (`node`, `bun`, `deno`, `python*`,
  `ruby`, `perl`) to the program they run, from the foreground process's
  argv: `node .../bin/codex` is now `codex`, `doas emerge` is `emerge`.

## 0.7.0

**Breaking change:** all AI/agent-title behaviour from 0.6.0 is removed.
See [docs/adr/0005-restore-deterministic-naming.md](docs/adr/0005-restore-deterministic-naming.md)
for the rationale.

- The window name is now `<activity>:<workspace>[/<area>]`, the same
  deterministic rule the pre-0.6 TypeScript version used, computed from
  `pane_current_command`, the pane's cwd, and the session - no agent
  titles, no mirroring, no normalisation of agent-specific title formats.
- `tmux-autoname set`, `clear`, the Pin, the sticky Task, the fixed
  Workspace, and `@tmux-autoname-agents`/`@tmux-autoname-max-width`/
  `@tmux-autoname-key-set`/`@tmux-autoname-key-clear`/`@tmux-autoname-key-pick`
  are all gone, along with the `pane-title-changed` hook,
  `@tmux-autoname-seen`, and `integrations/pi/session-title.ts`. `sync`,
  `auto`, and `status` remain; Manual Name precedence via
  `@tmux-autoname-applied`, restoring auto-naming with `auto` or
  `tmux rename-window ""`, and migration from the pre-0.6 daemon's
  per-window state are all kept working.
- Added `@tmux-autoname-area-depth` (default `1`), which caps the Area to
  its first path segment; set it to `0` for the original, unlimited
  relative-path Area. This is a new addition on top of the ported rule,
  not part of the original TypeScript naming logic.
- Added an `after-kill-pane` hook (syncing the window that remains, not
  the killed pane's now-gone window) and an optional
  `@tmux-autoname-key-auto` binding that runs `auto` on the current window.
- Added `integrations/tmux-autoname.zsh`, an optional but recommended zsh
  integration: tmux has no hook for a foreground-program or `cwd` change,
  so without it, naming only updates on tmux's own window/pane/session
  events. Source it from `.zshrc` to also sync (backgrounded, disowned)
  right after a command starts, right before the next prompt, and on `cd`.

Also carries these fixes, made during 0.6.0 dogfooding against real
`claude`/`codex`/`pi` on tmux 3.6a, whose underlying agent-title code this
release now removes wholesale:

- The loader no longer picks up a `TMUX_AUTONAME_BIN` inherited from the
  process environment (an old 0.5 install used to `export` it), which could
  pin hooks to a stale binary. The binary always resolves to this
  checkout's `bin/tmux-autoname`, unless `@tmux-autoname-bin` is set
  *before* the plugin loads; the loader no longer overwrites that option.
- The session-container Workspace rule matched any ancestor directory of
  the pane path that happened to share the session's name, which could
  point at an unrelated directory (session `dev` + pane path
  `~/dev/partjobs` incorrectly gave Workspace `dev`). It now requires
  `#{session_path}`'s basename to equal the session name, and the pane
  path to be that directory or under it.
- codex's status glyph (spinner) was left in the window name instead of
  being stripped, and a glyph-only placeholder title was accepted as
  meaningful. `normalize_title()` now strips a leading glyph for every
  agent and treats any candidate with no letters, digits, or CJK
  characters as a placeholder; the `pane-title-changed` hook filter was
  updated to strip codex's trailing ` | <project>` too, so it agrees with
  `normalize_title()` on what counts as a title change and a stale spinner
  can no longer get stuck in the window name.
- The first window of a brand-new server was never named: the plugin loads
  before the first session exists, and the loader's final sync only
  covered the current window. Added a `session-created[120]` hook, and the
  final pass now syncs every window on every session.
- The `set` key binding prefilled with `@tmux-autoname-label`
  (`workspace/title`), so accepting it unchanged pinned
  `workspace/workspace/title`. It now prefills with the current pin, or
  the sticky agent title if there is no pin. Titles containing an
  apostrophe also silently failed to save, because the prompt template
  substituted the response inside single quotes; the pin is now set
  directly from the prompt's own double-quoted `"%%%"` substitution, so
  apostrophes and other shell-special characters round-trip.
- The `choose-tree` picker printed a duplicate window index
  (`3: 3: dev/...`) and leaked a window's label onto its session row. The
  format no longer includes `#{window_index}` (choose-tree already
  prefixes it) and only renders `@tmux-autoname-label` on window rows.
- Per-window state left by the pre-0.6 daemon (`@tmux-autoname-state`,
  base64 JSON, and `@tmux-autoname-badge`) is now migrated explicitly: a
  window the old daemon had in manual mode stays manual, one it had in
  automatic mode is handed to the new plugin, and both options are unset
  either way. A window with no old state but `automatic-rename` explicitly
  off (a plain manual rename, unrelated to tmux-autoname) is also treated
  as manual. Undecodable old state is treated as manual too, since a name
  is never overwritten when the old state can't be trusted.

## 0.6.0

**Breaking change:** the TypeScript/Bun runtime, the resident inference
daemon, the config file (`config/config.example.toml`,
`~/.config/tmux-autoname/config.toml`), the AI provider/credential
settings, the window-tab badge, and the offline naming-quality eval
harness are all removed. The plugin is now POSIX `sh`, has no build
step, and needs no API key: see
[docs/adr/0004-mirror-agent-titles.md](docs/adr/0004-mirror-agent-titles.md).

- A Window's Task is now the title the agent running in it (Claude
  Code, codex, or pi) already reports through its terminal title,
  mirrored via `pane_title`, instead of a task inferred from screen text
  by a model call.
- `tmux-autoname refresh`, `tmux-autoname new`, `tmux-autoname explain`,
  and `tmux-autoname secrets reload` are gone. `tmux-autoname set`,
  `clear`, `auto`, `status`, and `sync` take over: `set` replaces the
  role `refresh`-with-a-manual-value played, `clear` replaces `new`,
  and `status` replaces `explain`.
- `@tmux-autoname-badge`, `@tmux-autoname-badge-style`,
  `@tmux-autoname-install-badge`, `@tmux-autoname-profile`, and
  `@tmux-autoname-server-state` are gone; the appended badge fragment is
  removed from `window-status-format`/`window-status-current-format` on
  first load after upgrading.
- `@tmux-autoname-key-refresh`/`-auto`/`-new` are replaced by
  `@tmux-autoname-key-set`/`-clear`/`-pick`.
- Loading the new `tmux-autoname.tmux` migrates a prior install
  automatically: it stops the old daemon, overwrites the old `[120]`
  hooks, removes the badge fragment, and unsets the obsolete options
  above. Manual Names (windows you renamed yourself) are left untouched.
- Added `integrations/pi/session-title.ts`, a pi extension that names an
  unnamed pi session after its first turn so pi windows behave like
  Claude Code windows. Removed `integrations/tmux-autoname.zsh`, the
  zsh preexec/precmd event emitter for the old daemon.
- Added `test/run.sh`, an end-to-end suite that drives real isolated
  tmux servers with fake agent processes, replacing the Bun/Vitest test
  suite and the eval harness.
