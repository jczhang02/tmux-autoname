# Changelog

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
