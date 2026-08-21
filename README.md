# tmux-autoname

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname gives tmux windows names that describe the current work instead of repeating the foreground executable.

```text
codex:tmux-autoname/improve-process-detection
pi:partjobs/client-a/review-payment-flow
nvim:website/fix-mobile-navigation
```

The default format is `activity:scope/task`.

- Activity comes from the active foreground process.
- Scope comes from tmux, cwd, Git, and path evidence. The model selects from local candidates and cannot invent a path.
- Task is a validated English action slug with 2 to 5 lower-case words joined by hyphens.

The plugin runs asynchronously. It keeps manual names intact and never opens a prompt or popup. A small badge in the window tab reports its state.

## How it works

- Nested directories remain visible. A `partjobs` session can use a name such as `pi:partjobs/client-a/review-payment-flow` after you enter `client-a`.
- Process detection looks through Linux `systemd-run` wrappers, so tools such as `codex` and `pi` keep their own activity names.
- The screen monitor works with terminal programs directly. You do not need a Codex, Claude Code, Pi, or editor extension.
- AI runs after useful evidence changes and the visible screen settles. Duplicate prompt redraws do not trigger another request.
- Scope IDs, revisions, and evidence fingerprints are checked before a generated name is accepted. Late or malformed results are discarded.
- Local process and path metadata stays current for every pane. Terminal text is captured only from panes visible in attached clients.

## Requirements

- tmux 3.2 or newer
- Bun 1.3 or newer for installation and development
- OpenAI, Anthropic, or an OpenAI-compatible provider
- zsh only if you use the optional shell lifecycle integration
- `op`, `secret-tool`, or macOS `security` if you use that credential source

## Install with TPM

Add the plugin to your tmux configuration:

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

Press `prefix` + <kbd>I</kbd>. TPM clones the repository, but this repository does not commit the compiled binary, so build it once after each install or update:

```sh
plugin_dir="${TMUX_PLUGIN_MANAGER_PATH:-$HOME/.tmux/plugins}/tmux-autoname"
cd "$plugin_dir"
bun install --frozen-lockfile
bun run build
tmux source-file ~/.tmux.conf
```

If you keep TPM or tmux under XDG directories, use the matching paths. Common examples are `~/.config/tmux/plugins/tmux-autoname` and `~/.config/tmux/tmux.conf`.

## Install manually

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
cd ~/.tmux/plugins/tmux-autoname
bun install --frozen-lockfile
bun run build
```

Load the plugin from `~/.tmux.conf`:

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

Add the plugin's `bin` directory to `PATH` if you want to call its commands by name:

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

## Configure AI

Copy the example configuration:

```sh
mkdir -p ~/.config/tmux-autoname
cp config/config.example.toml ~/.config/tmux-autoname/config.toml
```

The plugin has no default provider or model. This minimal example uses an OpenAI-compatible endpoint and a 1Password reference:

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

You can store the key directly in the same file instead:

```toml
[ai]
provider = "openai-compatible"
model = "your-fast-model"
base_url = "https://api.example.com/v1"
api_key = "your-api-key"
```

`api_key` and `[ai.credential]` cannot be used together. A plaintext key is easy to set up but remains on disk. Limit access to the file:

```sh
chmod 600 ~/.config/tmux-autoname/config.toml
```

Credential references support these sources:

| Source | Configuration | Behavior |
|---|---|---|
| 1Password | `source = "onepassword"` and an `op://` reference | Uses the 1Password CLI and its desktop app integration |
| Linux keyring | `source = "keyring"`, `service`, and `account` | Reads from the logged-in Secret Service session with `secret-tool` |
| macOS Keychain | `source = "keychain"`, `service`, and `account` | Reads from the unlocked user Keychain with `security` |
| Environment | `source = "env"` and `name` | Reads the named variable from the tmux server environment |

The daemon resolves a credential on the first model request and keeps it in memory. It does not ask the password manager for every rename. After changing the configuration or key, run:

```sh
tmux-autoname secrets reload
```

This restarts the daemon, clears cached credentials and authentication failures, and preserves hourly request counts. A provider response with status 401 or 403 also clears the cached credential.

The default configuration path is `~/.config/tmux-autoname/config.toml`. Set `TMUX_AUTONAME_CONFIG` to use another file.

## Use it

Loading the plugin starts one daemon for the tmux server. The default monitor checks every 3 seconds and waits for 4 seconds of stable visible content before considering an AI request.

Use tmux's normal rename binding, usually `prefix` + <kbd>,</kbd>, to take manual control of a window name. The plugin leaves a non-empty manual name unchanged until you run:

```sh
tmux-autoname auto
```

User-facing commands:

| Command | What it does |
|---|---|
| `tmux-autoname refresh` | Requests inference now, waits for the final applied, failed, or blocked result, and prints it |
| `tmux-autoname explain` | Prints the current name record, mode, badge, error, request counts, and circuit state without requesting inference |
| `tmux-autoname auto` | Clears a manual name and returns the window to automatic mode |
| `tmux-autoname secrets reload` | Restarts the daemon and reloads configuration and credentials |

`refresh`, `auto`, and `explain` accept `--window @ID` or `--pane %ID`. Inside tmux they otherwise use the current pane. Add `--json` to `refresh` or `explain` for structured output.

`refresh` skips the debounce and minimum call interval. Hourly quotas and the circuit breaker still apply.

### Optional zsh lifecycle events

The screen monitor does not require shell integration. If you want command start and finish events to act as extra scheduling signals, add this to `~/.zshrc`:

```zsh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

The integration sends the command basename and exit status. It does not send command arguments.

## Window-tab badges

The plugin appends its badge to your existing `window-status-format`; it does not replace the theme.

| State | Plain | Nerd Font |
|---|---:|---:|
| Generating | `…` | `󰚩` |
| Failed | `!` | `` |
| Secret unavailable | `K!` | `` |
| Manual ownership | `M` | `` |
| Healthy | empty | empty |

Enable Nerd Font badges before loading the plugin:

```tmux
set -g @tmux-autoname-badge-style 'nerd'
```

To place the badge in your status format yourself:

```tmux
set -g @tmux-autoname-install-badge 'off'
```

The window-scoped value is `#{@tmux-autoname-badge}`.

## tmux and process compatibility

The loader disables tmux's built-in `automatic-rename`, installs indexed hooks, and appends its badge without replacing unrelated hooks or status formats.

Each daemon reports a build identity. Reloading a newer build replaces the stale daemon cleanly.

On Linux, the process resolver inspects the foreground process group when tmux reports `systemd-run`. It resolves the executable after an explicit `--` separator. A command launched through `systemd-run --wait --pty -- …` therefore remains `codex` or `pi`. If inspection fails, the activity safely stays `systemd-run`. The resolver does not persist or send the raw procfs command line.

Agent completion notifications are separate. tmux-autoname does not emit or consume OSC notifications and does not rename a window because an agent finished.

## Privacy, cost, and resource use

> [!IMPORTANT]
> A model request contains the active pane's rendered tail and structured tmux, cwd, process, title, Git/path candidate, previous-name, and limited supporting-pane metadata. Choose a provider and endpoint that you trust with this data.

Terminal context is limited to 50 lines and 8 KiB. Common secret formats are redacted locally on a best-effort basis. The context stays in memory and is not written to tmux state or logs. The plugin does not send full scrollback, environment dumps, shell history, or raw procfs command lines. Command arguments already visible in the terminal capture can be included.

The plugin calls AI only after settled evidence changes. The defaults allow at most six requests per window and thirty requests per tmux server per hour. Output is capped at 512 tokens. Typical captured prompts measured about 250 to 500 input tokens; captures near the 8 KiB limit measured about 2,500 to 5,000. Provider tokenizers differ.

A local steady-state test with one visible pane averaged 0.7% CPU for 30 seconds, with stable memory and file descriptor counts. Hardware and workloads differ. You can lower the quotas:

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

`bun run check` runs type checking, unit and simulation tests, an isolated tmux E2E test with a local fake provider, and shell validation.

The optional release soak runs for 30 minutes:

```sh
bun run test:soak
```

The simulation advances 24 hours of logical time. It does not wait for 24 hours of wall-clock time. See [SPEC.md](SPEC.md) for the behavior contract and [SPEC.zh-CN.md](SPEC.zh-CN.md) for its Chinese version.
