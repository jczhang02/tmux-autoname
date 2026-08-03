# tmux-autoname

Automatic tmux window names based on the work running inside each pane.

Local heuristics handle shells, editors, tests, and build tools. Coding-agent windows can optionally use Pi and an LLM to derive a stable task name.

```text
shell:dotfiles
nvim:scanner
pytest:auth
pi:tmux-plugin
```

Manual names always win. If you rename a managed window yourself, tmux-autoname leaves it alone until you reset that window.

## Requirements

- Linux
- tmux
- [Bun](https://bun.sh/) 1.3.14 or newer (CI is pinned to 1.3.14)
- `flock` from util-linux
- [Pi](https://github.com/earendil-works/pi) only when LLM naming is enabled

## Install with TPM

Add the plugin to your tmux configuration:

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Install plugins with TPM, then reload tmux. The plugin starts one daemon for each tmux server and binds:

```text
prefix N  reset and rescan the current window
```

For a local checkout, source its entry file instead:

```tmux
run-shell -b '/path/to/tmux-autoname/tmux-autoname.tmux'
```

## Configuration

The first run creates `$XDG_CONFIG_HOME/tmux-autoname/config.toml`, or `~/.config/tmux-autoname/config.toml` when the XDG variable is unset or invalid. The directory and file use private permissions.

```toml
# LLM naming is opt-in because it sends terminal data to a provider.
# There is no automatic secret redaction. Read README.md before enabling it.
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

LLM naming remains off unless `llm.enabled = true` is set explicitly. An empty tool list is valid, so `ai = []` also disables AI-tool detection.

## Privacy

Heuristic naming stays local. When LLM naming is enabled, tmux-autoname does the following for every unlocked AI-tool window, including windows in detached sessions:

1. Reads the visible active pane plus up to 1,000 lines of its history.
2. Removes the recognized tool startup header and samples the configured head and tail line counts.
3. Limits the sample to 64 KiB.
4. Sends the sample, tool name, pane working directory, and current window name to the configured provider through Pi.

Terminal text is not reliably secret-redacted. It may contain commands, output, prompts, paths, tokens, or other sensitive data. Provider stderr and invalid model output are never copied into the persistent log. After an AI name succeeds, that window is locked and is not captured again unless it is reset.

Pi runs with tools, sessions, extensions, skills, and context files disabled for this request. `PI_OFFLINE=1` prevents Pi's optional online package discovery; it does not prevent the configured model provider request.

## Commands

Run commands from the plugin checkout:

```bash
bun bin/tmux-autoname.ts start
bun bin/tmux-autoname.ts status
bun bin/tmux-autoname.ts stop
bun bin/tmux-autoname.ts once
bun bin/tmux-autoname.ts reset-current @1
bun bin/tmux-autoname.ts config
```

`daemon` runs in the foreground for debugging. Normal tmux startup uses `start` in the background. `once` intentionally refuses to run while a daemon or another one-off scan is active, preventing duplicate provider requests. A reset invalidates any provider result already in flight; when the daemon is active, the reset is picked up on its next poll.

## Runtime behavior

- A kernel `flock` guarantees one daemon or one-off scan per real tmux server, including concurrent plugin reloads.
- `start` fingerprints the loaded source and checkout path, replacing an outdated daemon after a plugin update or checkout change.
- The daemon verifies the tmux socket, server PID, and server process start time before every scan. It exits when that server stops or the socket is reused by a new server.
- Window renames and reset consumption are conditional tmux updates: they apply only if the live name and reset state still match what the scanner observed. A last-second manual rename is therefore preserved.
- Lock files live in a private, per-user directory beside the tmux socket. This makes every client of the same server use the same lock even if their XDG environments differ.
- Each server writes its own log under `$XDG_STATE_HOME/tmux-autoname`, falling back to `~/.local/state/tmux-autoname`. Logs use mode `0600`, rotate at 1 MiB, and retain one backup. Startup cleanup keeps the eight most recently modified families on a best-effort basis; an active server recreates its log after another server removes it.
- `@autoname_daemon` and `@autoname_pid` are status and signal metadata. Neither replaces the kernel lock.

## Uninstall

1. Run `bun bin/tmux-autoname.ts stop` inside every tmux server you use.
2. Remove the `@plugin` line and let TPM remove the plugin.
3. Restart tmux to remove the `prefix N` binding and plugin globals. A config reload alone does not remove an existing binding. Window-local name metadata disappears with those windows.
4. Optionally remove the `tmux-autoname` directories under your XDG config and state locations, plus the hidden lock directory beside each tmux socket.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

The check runs strict TypeScript validation, the unit/integration test suite, and ShellCheck. GitHub Actions runs the same checks on pushes and pull requests.

Core modules live under `src/`:

- `naming-engine.ts` decides whether to preserve, lock, or rename a window during steady-state scans.
- `scanner.ts` coordinates tmux, process inspection, reset fencing, heuristics, and optional LLM naming.
- `daemon-lifecycle.ts` owns server identity, diagnostic records, and lock setup.
- `tmux-adapter.ts` contains all tmux CLI access.
- `runtime-logger.ts` and `runtime-paths.ts` own private bounded state.

## License

[MIT](LICENSE) © 2026 JC Zhang.
