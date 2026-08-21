# tmux-autoname

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

AI-first tmux window names that describe the work, not just the executable.

```text
codex:tmux-autoname/improve process detection
pi:partjobs/client-a/review payment flow
nvim:website/fix mobile navigation
```

Names use `activity:scope/task`:

- **Activity** is resolved locally from the active foreground process.
- **Scope** is selected from tmux, cwd, and Git evidence; the model cannot
  invent paths.
- **Task** is a validated 2–5 word English action phrase generated from a
  small rendered terminal tail.

The plugin is asynchronous, preserves manual names, and never puts a prompt or
popup in the terminal. Its state appears as a small window-tab badge instead.

## Why this plugin

- Understands what an agent or command is doing, beyond names such as `node`
  or `systemd-run`.
- Keeps nested project context: a `partjobs` session can become
  `pi:partjobs/client-a/review payment flow` after entering `client-a`.
- Uses only grounded scope candidates and rejects stale or malformed model
  output.
- Watches only panes visible in attached clients and calls AI only after the
  screen settles and evidence changes.
- Requires no Codex, Claude Code, Pi, or editor-specific extension.

## Requirements

- tmux 3.2 or newer
- Bun 1.3 or newer for installation and development
- An AI provider compatible with OpenAI, Anthropic, or the OpenAI API shape
- zsh only if you enable the optional shell lifecycle integration
- The CLI for your chosen secret backend: `op`, `secret-tool`, or macOS
  `security`

## Installation

### TPM

Add the plugin to your tmux configuration:

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Press `prefix` + <kbd>I</kbd> to install it, then build the current source
distribution once:

```sh
plugin_dir="${TMUX_PLUGIN_MANAGER_PATH:-$HOME/.tmux/plugins}/tmux-autoname"
cd "$plugin_dir"
bun install --frozen-lockfile
bun run build
tmux source-file ~/.tmux.conf
```

If your TPM directory or tmux configuration lives under XDG paths, use those
paths instead—for example `~/.config/tmux/plugins/tmux-autoname` and
`~/.config/tmux/tmux.conf`.

> [!NOTE]
> The repository does not currently commit a built binary. A clean TPM clone
> therefore needs the one-time build above after installation or update.

### Manual

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
cd ~/.tmux/plugins/tmux-autoname
bun install --frozen-lockfile
bun run build
```

Add the loader to `~/.tmux.conf`:

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

Add the plugin's `bin` directory to `PATH` if you want to run its commands by
name:

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

## Configure AI

Start from the example configuration:

```sh
mkdir -p ~/.config/tmux-autoname
cp config/config.example.toml ~/.config/tmux-autoname/config.toml
```

A minimal OpenAI-compatible configuration looks like this:

```toml
[ai]
provider = "openai-compatible"
model = "your-fast-model"
base_url = "https://api.example.com/v1"
confidence_threshold = 0.6

[ai.credential]
source = "onepassword"
ref = "op://Private/OpenAI/api-key"
```

For a plaintext key, replace the `[ai.credential]` table with `api_key` inside
the `[ai]` table:

```toml
[ai]
provider = "openai-compatible"
model = "your-fast-model"
base_url = "https://api.example.com/v1"
api_key = "your-api-key"
```

`api_key` and `[ai.credential]` are mutually exclusive. A plaintext key is the
simplest option but is stored directly on disk; restrict the configuration file
to your user:

```sh
chmod 600 ~/.config/tmux-autoname/config.toml
```

Available reference backends are:

| Source | Configuration | Unlock behavior |
|---|---|---|
| 1Password | `source = "onepassword"` and an `op://` reference | Use 1Password CLI desktop-app integration |
| Linux keyring | `source = "keyring"`, `service`, and `account` | Uses the logged-in Secret Service session |
| macOS Keychain | `source = "keychain"`, `service`, and `account` | Uses the user's unlocked Keychain |
| Environment | `source = "env"` and `name` | Variable must exist in the tmux server environment |

The credential is loaded only on the first model request and cached in daemon
memory, so a password manager is not called for every rename. Run this after a
configuration or key change:

```sh
tmux-autoname secrets reload
```

A provider 401/403 response also clears the cached credential.

## Usage

Once loaded, the plugin starts its daemon and names visible windows
automatically. The default monitor checks every 3 seconds and waits for 4
seconds of stable screen content before considering an AI request.

Use the normal tmux rename binding—commonly `prefix` + <kbd>,</kbd>—to set a
manual name. A non-empty manual name always wins until automation is restored:

```sh
tmux-autoname auto
```

Other commands:

```text
tmux-autoname refresh          request inference now, within quota
tmux-autoname explain          show the current record and safe diagnostics
tmux-autoname secrets reload   reload configuration and credentials
```

`refresh`, `auto`, and `explain` accept `--window @ID` or `--pane %ID`; inside
tmux they otherwise target the current pane.

### Optional zsh lifecycle events

The screen monitor works without shell integration. To send immediate command
start/finish events as an additional scheduling signal, add this to `~/.zshrc`:

```zsh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

This integration sends only the command basename and exit status. It does not
send command arguments.

## Window-tab badges

Badges are appended to the existing `window-status-format`; they do not replace
your theme.

| State | Plain | Nerd Font |
|---|---:|---:|
| Generating | `…` | `󰚩` |
| Failed | `!` | `` |
| Secret unavailable | `K!` | `` |
| Manual ownership | `M` | `` |

Enable Nerd Font badges before the plugin is loaded:

```tmux
set -g @tmux-autoname-badge-style 'nerd'
```

To place the badge yourself, also set:

```tmux
set -g @tmux-autoname-install-badge 'off'
```

The window-scoped value is available as `#{@tmux-autoname-badge}`.

## Process and tmux compatibility

The loader disables tmux's built-in `automatic-rename` so it cannot overwrite
semantic names. It installs indexed hooks and appends its badge idempotently,
allowing unrelated indexed hooks and status themes to coexist.

On Linux, when tmux reports `systemd-run` as the active command, the plugin
reads the pane's foreground process group from procfs and resolves only the
executable after systemd-run's explicit `--` separator. For example, these
remain `codex` and `pi` even when launched through a resource-limiting
`systemd-run --wait --pty -- …` wrapper. Failures safely fall back to
`systemd-run`; the raw command line is never persisted or sent to the model.

Agent completion notifications are independent. The plugin neither emits nor
consumes OSC notifications and never renames a window on agent completion.

## Privacy, cost, and resources

> [!IMPORTANT]
> AI requests contain the active pane's rendered tail plus structured tmux,
> cwd, process, title, Git/path candidate, previous-name, and limited supporting
> pane metadata. Use a provider and endpoint appropriate for that data.

Terminal context is capped at 50 lines and 8 KiB, redacted locally for common
secret formats, kept in memory, and never written to tmux state or logs.
Redaction is best-effort. Full scrollback, environment dumps, shell history,
and raw procfs command lines are not sent. Command arguments already visible in
the rendered terminal tail can be included.

AI runs only when settled evidence changes. Defaults cap requests at six per
window and thirty per tmux server per hour, with output limited to 64 tokens.
Measured prompts were roughly 400–700 input tokens for typical captures and
2,500–5,000 near the 8 KiB limit; provider tokenizers vary.

A local steady-state sample with one visible pane averaged 0.7% CPU over 30
seconds, with stable RSS and file descriptors. This is a measurement, not a
hardware-independent guarantee. Lower the quotas if needed:

```toml
[limits]
minimum_call_interval_ms = 30000
max_calls_per_window_hour = 3
max_calls_per_server_hour = 15
```

## Development and verification

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs type checking, unit and simulation tests, a real isolated tmux E2E
test with a local fake provider, and shell validation. The opt-in release soak
test runs for 30 real minutes:

```sh
bun run test:soak
```

The simulation advances 24 hours of logical time; no 24-hour wall-clock run is
required. See [SPEC.md](SPEC.md) for the behavior contract and
[SPEC.zh-CN.md](SPEC.zh-CN.md) for its Chinese version.
