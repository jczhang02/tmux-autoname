# tmux-autoname

AI-first, event-driven tmux window names with manual ownership.

The default format is `activity:scope/task`, for example
`codex:tmux-autoname/redesign naming runtime`. Activity is local and immediate;
Scope is grounded in tmux, cwd, and git evidence; Task is the short English
action phrase selected by the configured model from the active terminal screen.
The plugin never truncates the stored name. Normal tmux status-format rules
control what is visible.

No Codex, Claude Code, Pi, or other Agent extension is installed or required.
The daemon checks only panes visible in attached tmux clients. It captures a
small rendered tail after the screen has been quiet, rather than streaming or
recording terminal output.

## Requirements

- tmux 3.2 or newer
- Bun 1.3 or newer
- zsh for the optional shell integration

## Install

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
cd ~/.tmux/plugins/tmux-autoname
bun install --frozen-lockfile
bun run build
```

Add this to `~/.tmux.conf`:

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

For zsh lifecycle events, add this to `~/.zshrc`:

```zsh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

## Configure AI

Copy [`config/config.example.toml`](config/config.example.toml) to
`~/.config/tmux-autoname/config.toml`, then set an explicit provider and model.
Supported providers are `openai`, `anthropic`, and `openai-compatible`.

Credentials are lazy-loaded into daemon memory. Configuration accepts only a
reference, never a literal key:

```toml
# 1Password CLI; use its desktop-app integration to avoid repeated unlocks.
[ai.credential]
source = "onepassword"
ref = "op://Private/OpenAI/api-key"
```

```toml
# Linux Secret Service / system keyring.
[ai.credential]
source = "keyring"
service = "tmux-autoname"
account = "openai"
```

```toml
# macOS Keychain.
[ai.credential]
source = "keychain"
service = "tmux-autoname"
account = "openai"
```

An environment-variable reference is also supported, but the variable must be
available to the tmux server process. Run `tmux-autoname secrets reload` after
changing configuration or rotating a key; it restarts the daemon and reloads
both. Provider 401/403 responses clear the cached value automatically.

When AI is configured, the provider receives the active pane's rendered tail:
at most 50 lines and 8 KiB after local redaction of common secret formats. Raw
screen text is kept in memory only and is never written to tmux options, state,
or logs. Redaction is best-effort; choose the provider and endpoint accordingly.

The default monitor interval is 3 seconds and the screen must remain unchanged
for 4 seconds before inference. Only panes visible in attached clients are
checked. Model calls are capped at six per window and thirty per tmux server per
hour.

## Resource and token use

AI runs only after visible terminal content settles and its evidence changes.
Explicit refreshes use the same quotas. In a local AI SDK transport test, a
typical prompt was 1,449 UTF-8 bytes (roughly 400-700 input tokens), while an
8 KiB terminal-context fixture produced a 9,517-byte prompt (roughly
2,500-5,000 input tokens). Provider tokenizers and structured-output schema
accounting vary, so these are measurements rather than billing guarantees.
Output is capped at 64 tokens.

At the default six-call window quota, that is roughly 2,400-4,200 input tokens
per window-hour for typical captures, or about 15,000-30,000 if every capture
is near the limit. For a lower-cost setup:

```toml
[limits]
minimum_call_interval_ms = 30000
max_calls_per_window_hour = 3
max_calls_per_server_hour = 15
```

A 30-second local steady-state sample with one attached visible pane averaged
0.7% CPU; RSS and open file descriptors remained stable. Treat this as a local
sample, not a hardware-independent guarantee. The release soak test checks for
unbounded growth over 30 minutes.

## Ownership and status

A non-empty `rename-window` enters manual mode and always wins. Restore
automation with an empty rename or `tmux-autoname auto`.

Window-tab badges are appended without replacing existing status formats:

| State | Plain | Nerd Font |
|---|---:|---:|
| Generating | `…` | `󰚩` |
| Failed | `!` | `` |
| Secret unavailable | `K!` | `` |
| Manual | `M` | `` |

Select the Nerd Font set with:

```tmux
set -g @tmux-autoname-badge-style 'nerd'
```

Set `@tmux-autoname-install-badge` to `off` before loading the plugin to manage
the status fragment yourself. There is no popup or blocking notification.

## Commands

```text
tmux-autoname refresh          request immediate inference within quota
tmux-autoname auto             restore automatic ownership
tmux-autoname explain          print the full record and safe diagnostics
tmux-autoname secrets reload   reload configuration and credentials
```

## Test

```sh
bun run check
bun run test:e2e
bun run test:simulation
bun run test:soak
```

E2E uses an isolated real tmux server and local fake provider. Simulation
advances 24 hours of logical time. The release soak runs for 30 real minutes;
no 24-hour wall-clock test is required. A paid-provider smoke test is optional.

See [`SPEC.md`](SPEC.md) for the complete behavior contract and
[`SPEC.zh-CN.md`](SPEC.zh-CN.md) for the Chinese version.
