<div align="center">
  <h1>tmux-autoname</h1>
  <p>Useful tmux window names derived from what each pane is actually doing.</p>
  <p>
    <a href="https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/jczhang02/tmux-autoname/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
    <a href="https://github.com/oven-sh/bun"><img alt="Bun 1.3.14+" src="https://img.shields.io/badge/Bun-1.3.14%2B-fbf0df?style=flat-square&amp;logo=bun&amp;logoColor=black"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  </p>
</div>

```text
shell:dotfiles    nvim:scanner
pytest:auth       pi:tmux-plugin
```

Local heuristics cover shells, editors, tests, and build tools. Coding-agent panes can optionally use [Pi](https://github.com/earendil-works/pi) and an LLM for stable task names. Your manual window names always take priority.

[Quick start](#quick-start) · [Naming](#how-naming-works) · [Configuration](#configuration) · [Privacy](#privacy) · [Commands](#commands)

## Highlights

- **Context-aware names** — uses the active process, working directory, Git root, editor target, or test target instead of a static process title.
- **Manual control stays authoritative** — a user rename is detected and preserved until that window is explicitly reset.
- **Local by default** — heuristic naming never calls a model; LLM naming is disabled unless you enable it.
- **Stable coding-agent names** — successful AI names lock, so a later prompt does not constantly rename the window.
- **One daemon per tmux server** — kernel locking, server identity checks, and conditional updates prevent duplicate scans and rename races.

## Quick start

### Requirements

- Linux
- tmux
- [TPM](https://github.com/tmux-plugins/tpm)
- [Bun](https://bun.sh/) 1.3.14 or newer
- `flock` from util-linux
- Pi only if you enable LLM naming

Add the plugin to `tmux.conf`:

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Install plugins with TPM and reload tmux. tmux-autoname starts one background daemon for each real tmux server.

To load a local checkout instead:

```tmux
run-shell -b '/path/to/tmux-autoname/tmux-autoname.tmux'
```

Press `prefix N` to clear tmux-autoname state for the current window and rescan it.

> [!NOTE]
> Rename a window normally whenever you want a permanent custom name. tmux-autoname detects the change and leaves that window alone; use `prefix N` only when you want automatic naming back.

## How naming works

The daemon inspects the active pane in every window on a configurable interval:

| Active work | Naming source | Example |
| --- | --- | --- |
| Shell in a Git checkout | Git root or working directory | `shell:dotfiles` |
| Vim/Neovim | Editor target or project | `nvim:scanner` |
| Test/build command | Active target and selector | `pytest:auth` |
| Pi or Claude | Optional LLM-generated task slug | `pi:tmux-plugin` |

Heuristic names can evolve as the active work changes. A successful AI name is locked until reset. Existing custom names, manual renames, and last-second user changes are protected by conditional tmux updates.

## Configuration

The first run creates:

- `$XDG_CONFIG_HOME/tmux-autoname/config.toml`, or
- `~/.config/tmux-autoname/config.toml` when the XDG path is unset or invalid.

Print the resolved path with:

```bash
bun bin/tmux-autoname.ts config
```

The generated file is the source of truth for all defaults:

```toml
# LLM naming is opt-in because it sends terminal data to a provider.
# There is no automatic secret redaction. Read the Privacy section first.
[llm]
enabled = false
provider = "openai-codex"
model = "gpt-5.4-mini"
thinking = "off"
timeout_seconds = 45

[naming]
max_len = 24
poll_seconds = 30
min_non_empty_lines = 5
head_lines = 120
tail_lines = 120

[tools]
ai = ["pi", "claude"]
shells = ["bash", "zsh", "fish", "sh"]
editors = ["nvim", "vim", "vi"]
```

`llm.enabled` must be explicitly set to `true`; an empty `ai = []` list disables AI-tool detection entirely.

## Privacy

Heuristic naming stays on your machine.

> [!WARNING]
> LLM naming sends terminal content to the configured model provider. There is no reliable automatic secret redaction. Pane history can contain commands, output, prompts, paths, tokens, and credentials.

For each unlocked AI-tool window—including detached sessions—the plugin:

1. Captures the visible active pane and up to 1,000 history lines.
2. Removes a recognized Pi or Claude startup header.
3. Samples the configured head and tail line counts, capped at 64 KiB.
4. Sends the sample, tool name, working directory, and current window name through Pi.

Pi is invoked with tools, sessions, extensions, skills, and context files disabled. `PI_OFFLINE=1` disables Pi's optional package discovery, but it does not block the configured model-provider request. Provider stderr and invalid model output are not copied into persistent logs.

## Commands

Run these from the plugin checkout:

| Command | Purpose |
| --- | --- |
| `bun bin/tmux-autoname.ts start` | Start the current server's daemon; idempotent and quiet when already running |
| `bun bin/tmux-autoname.ts status` | Show daemon status for the current tmux server |
| `bun bin/tmux-autoname.ts stop` | Stop the current server's daemon |
| `bun bin/tmux-autoname.ts once` | Run one scan when no daemon or scan holds the server lock |
| `bun bin/tmux-autoname.ts reset-current [@id]` | Clear one window's manual/lock state and rescan |
| `bun bin/tmux-autoname.ts config` | Print the resolved config path |
| `bun bin/tmux-autoname.ts daemon` | Run a foreground daemon for debugging |

> [!TIP]
> `start` should not print an “already running” message during ordinary tmux reloads. If an older installation still does, update the TPM checkout and reload tmux; use `status` when you only want to inspect the daemon.

## Runtime guarantees

- A per-server kernel `flock` excludes duplicate daemons and one-off scans, including concurrent plugin reloads.
- The daemon fingerprints its loaded source and checkout path, replacing an outdated process after an update.
- Socket path, server PID, and process start time identify the real tmux server; the daemon exits when that server disappears.
- Renames and reset consumption use compare-and-set style tmux updates, preserving a manual rename made during a scan or model request.
- Per-server logs live under `$XDG_STATE_HOME/tmux-autoname` or `~/.local/state/tmux-autoname`, use private permissions, rotate at 1 MiB, and retain bounded history.
- Lock files live in a private per-user directory beside the tmux socket, so clients with different XDG environments still coordinate.

## Troubleshooting

First check the daemon and resolved config:

```bash
bun bin/tmux-autoname.ts status
bun bin/tmux-autoname.ts config
```

If a name should be automatic but is not changing, press `prefix N`: the window may be protected as manual or locked after AI naming. For daemon failures, inspect the private log files under the state directory described above.

## Uninstall

1. Run `bun bin/tmux-autoname.ts stop` in every tmux server you use.
2. Remove the plugin line and let TPM remove the checkout.
3. Restart tmux to remove the `prefix N` binding and plugin globals.
4. Optionally delete the `tmux-autoname` XDG config/state directories and its hidden lock directory beside each tmux socket.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs strict TypeScript validation, the unit/integration test suite, and ShellCheck. GitHub Actions runs the same checks.

| Module | Responsibility |
| --- | --- |
| `src/naming-engine.ts` | Preserve, lock, or rename each window |
| `src/scanner.ts` | Coordinate tmux, process inspection, reset fencing, heuristics, and optional LLM naming |
| `src/daemon-lifecycle.ts` | Own server identity, daemon records, and locking |
| `src/tmux-adapter.ts` | Isolate all tmux CLI access |
| `src/runtime-logger.ts` | Maintain private, bounded runtime logs |
