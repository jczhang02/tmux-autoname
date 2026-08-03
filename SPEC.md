# tmux-autoname MVP spec

## Goal

Name tmux windows by what work happens inside, not generic process names like `pi` or `claude`.

## Decisions

- Runtime: Bun TypeScript.
- Install: TPM-compatible plugin entry.
- Scope: all sessions/windows in one tmux server.
- Poll interval: 30 seconds.
- AI tools in v1: `pi`, `claude`.
- LLM backend: optionally reuse `pi` with the configured provider.
- Privacy: LLM naming is disabled by default and requires explicit opt-in.
- AI naming format: `<tool>:<ascii-kebab-slug>`.
- Max name length: 24 chars including tool prefix.
- AI capture strategy: strip known header if possible, then use head + tail content. Prefer stable project/task identity over latest short instruction.
- AI lock: first good AI name locks forever.
- Reset key: `prefix N` clears lock/manual state for the current window and invalidates any provider result already in flight; a running daemon rescans it on the next poll.
- Manual rename: if user changes a plugin-managed name, plugin marks window manual-protected forever until reset.
- Non-AI v1: `nvim/vim`, `pytest/cargo/bun/npm/pnpm/uv`, shell cwd/git repo. Non-AI names are not locked.
- Config: `$XDG_CONFIG_HOME/tmux-autoname/config.toml` with a standard home-directory fallback.
- State: window-scoped name metadata plus one server-global daemon record; no DB.
- Lifecycle: one kernel `flock` per tmux server identity; stale daemons exit when their server disappears or is replaced.
- Logs: private, bounded files under `$XDG_STATE_HOME/tmux-autoname`.
- Architecture: `bin/tmux-autoname.ts` coordinates CLI/daemon commands; reusable decisions, adapters, lifecycle primitives, paths, and logging live under `src/`.
- Naming decision: steady-state manual protection, AI lock, and generic-name protection are pure `NamingEngine` decisions. `WindowScanner` coordinates pending resets and candidates; live-name/reset checks and their side effects are committed conditionally inside tmux.
- Tmux access: tmux CLI formatting/parsing and state option writes are isolated in `TmuxAdapter`. Renames and reset consumption apply only when the live window name, reset generation, and pending state still match the scan.
- AI naming: pane sampling, prompt construction, `pi` invocation, and slug cleanup are separated behind an LLM adapter seam.
- Process discovery: active process selection uses a process snapshot resolver so nested shell commands are testable.
- Config: defaults, generated TOML, decode, and validation live in one ConfigCodec.

## State options

- `@autoname_managed=1`
- `@autoname_locked=1`
- `@autoname_manual=1`
- `@autoname_last_name=<name>`
- `@autoname_source=ai|editor|test|build|shell`
- `@autoname_reset_generation=<uuid>`
- `@autoname_reset_pending=1` (until a daemon consumes the reset)
- `@autoname_daemon=<validated JSON record>`
- `@autoname_pid=<diagnostic pid>`

## Example names

- `pi:mri-classifier`
- `claude:tmux-plugin`
- `nvim:SPEC.md` (sanitized/truncated by implementation)
- `pytest:auth`
- `cargo:build`
- `shell:dotfiles`
