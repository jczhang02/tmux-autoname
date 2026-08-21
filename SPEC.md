# tmux-autoname v3 Specification

Status: accepted implementation baseline

## 1. Purpose

tmux-autoname assigns stable, useful names to tmux windows. It combines
deterministic terminal facts with AI-generated task semantics while preserving
manual user control and never blocking normal terminal use.

The semantic vocabulary is defined in [`CONTEXT.md`](./CONTEXT.md). Research
supporting this specification is recorded in
[`docs/research/naming-landscape.md`](./docs/research/naming-landscape.md) and
[`docs/research/secret-loading.md`](./docs/research/secret-loading.md).

## 2. Goals

- Produce names from `Scope + Task + Activity`.
- Use AI as the sole generator of Task and as the selector of ambiguous Scope
  boundaries.
- Support nested workspaces such as a `partjobs` session whose active pane is in
  `high-value-patent-rebuild/manuscript`.
- Work with every terminal program without Agent-specific extensions, hooks, or
  APIs.
- Keep automatic tmux paths silent and non-blocking.
- Preserve manual names until the user explicitly restores automation.
- Remain useful when the model, network, password manager, or daemon fails.

## 3. Non-goals for v3

- Streaming pane output or running one control-mode client per session.
- Parsing Agent-specific UIs, spinners, or undocumented transcript formats.
- Generating a new Task for every terminal line or every user prompt.
- Popup, TUI, menu, or animated status indicators.
- SQLite, vector search, embeddings, or a prompt-history database.
- Native keyring add-ons or a public provider/plugin framework.
- Allowing AI to invent filesystem paths or process identities.

## 4. Name model

```ts
type Scope = {
  workspace: string;
  area?: string;
};

type NameRecord = {
  scope: Scope;
  task: string;
  activity: string;
};
```

Responsibilities:

- **Scope**: local code discovers candidates; AI selects among candidates when
  the boundary is ambiguous.
- **Task**: generated only by AI. It represents the stable user goal, not the
  latest command.
- **Activity**: determined locally from the active pane and foreground process.
- **Display Profile**: renders a Name Record; it does not change semantics.

The default Display Profile is:

```text
{activity}:{scope}/{task}
```

`scope` renders as `workspace` or `workspace/area`. Empty components and their
adjacent separators are omitted. A profile change re-renders the existing
record without calling AI.

Task is always a concise English action phrase: two to five lower-case words,
with no trailing punctuation.

## 5. Runtime and dependencies

- TypeScript with strict mode.
- Bun for development, tests, and standalone builds.
- Vercel AI SDK for provider-independent model calls.
- Zod for configuration and structured model-output validation.
- A small TPM shell loader for installation and tmux hooks.
- One daemon per tmux server.
- A Unix socket under `XDG_RUNTIME_DIR` for local event delivery.

Release builds must disable Bun runtime autoloading of `.env` and
`bunfig.toml`:

```sh
bun build --compile \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  src/cli.ts \
  --outfile dist/tmux-autoname
```

Automatic hook paths must produce no stdout or stderr. Diagnostics go to a
bounded log and the explicit `explain` command.

## 6. Architecture

```text
tmux hooks, a bounded screen monitor, and shell events
              |
              v
        Window Snapshot
              |
              v
   Scope and Activity candidates
              |
              v
       Trigger and deduplication
              |
              v
     AI Scope selection + Task
              |
              v
 revision/manual/schema acceptance gate
              |
              v
         Display Profile
              |
              v
      tmux rename-window
```

The daemon hides event coalescing, snapshot collection, process inspection,
candidate generation, model calls, revision fencing, manual ownership,
rendering, credential caching, and tmux writes.

The implementation uses tmux hooks, optional shell events, and a low-frequency
monitor of panes visible in attached clients. After the rendered screen is
unchanged for the settle period, the runtime captures at most 50 lines and 8
KiB for one inference. It does not use tmux control mode, stream pane output,
or install Agent extensions.

## 7. Evidence hierarchy

Evidence is considered in this order:

1. Explicit Manual Name.
2. Bounded rendered text from the active pane after it settles.
3. Shell command lifecycle event with cwd and exit status when available.
4. tmux, process, git, and path metadata.
5. Pane title as a low-confidence hint.

The active pane controls Activity. Other panes may contribute Scope and Task
evidence but cannot independently rename the shared window.

The model request sends no environment variables, git diffs, full scrollback,
command arguments, or unbounded output. Terminal evidence is capped at 50 lines
and 8 KiB, strips control characters, and applies best-effort redaction for
common credential formats. It is memory-only and never persisted or logged.
Because arbitrary terminal text cannot be perfectly redacted, configuring an AI
provider is also the user's explicit routing and privacy decision.

## 8. Scope candidate generation

Local code builds candidates from:

- tmux session creation/start directory when available;
- active and supporting pane cwd values;
- git/worktree roots;
- remote host identity;
- stable common ancestors;
- shortest distinguishing path suffixes across session windows.

A session name is context, not automatically a Workspace. Raw cwd is evidence,
not automatically Scope.

Each candidate has an opaque ID, label, kind, and grounded path or host facts.
AI may select candidate IDs but may not return arbitrary paths.

Example input:

```text
session       = partjobs
session root  = ~/dev/partjobs
git root      = ~/dev/partjobs/high-value-patent-rebuild
cwd           = ~/dev/partjobs/high-value-patent-rebuild/manuscript
process       = codex
```

Expected semantic result:

```text
Workspace = partjobs
Area      = high-value-patent-rebuild/manuscript
Activity  = codex
```

## 9. Normalized events

The daemon accepts a small event vocabulary:

```ts
type SemanticEventKind =
  | "command_started"
  | "command_finished"
  | "content_settled"
  | "window_changed"
  | "manual_name_changed"
  | "refresh_requested";
```

The core tmux integration emits bounded JSON through the Unix socket. The zsh
lifecycle integration is optional and sends only command basenames and exit
codes. Secrets and terminal text never appear in argv. There are no
Agent-specific adapters or extension installation paths.

## 10. AI trigger policy

AI generation occurs when:

- the active pane's bounded rendered content changes and then settles;
- Scope crosses a Workspace or meaningful Area boundary;
- a meaningful generic-shell command completes and no stable Task exists;
- the user explicitly runs `tmux-autoname refresh`.

AI generation does not occur merely because:

- a window or pane is selected;
- an individual terminal output chunk arrives or the screen is still changing;
- Activity changes while Scope and Task remain valid;
- an evidence fingerprint is unchanged.

Initial internal defaults:

```text
debounce                 1000 ms
active-pane scan          3000 ms
content settle            4000 ms
minimum call interval   10000 ms per window
in-flight requests      1 per window
request timeout         4000 ms
automatic model retries 0
automatic calls          6 per window per hour
automatic calls         30 per tmux server per hour
failure circuit opens    after 3 consecutive failures
failure circuit cooldown 10 minutes
```

A forced refresh bypasses fingerprint deduplication and the minimum interval,
but not manual ownership, request validation, hourly quotas, or the circuit
breaker. Every provider request is charged against the same quotas. When a
quota or circuit breaker blocks inference, the last-known-good or deterministic
fallback name remains active.

## 11. AI request and result

The request contains only bounded evidence:

- previous Name Record and provenance;
- Scope candidates and IDs;
- deterministic Activity;
- active-pane cwd, command, and title;
- the active pane's redacted rendered tail, capped at 50 lines and 8 KiB;
- active pane structured event;
- short supporting-pane metadata;
- window ID, revision, and evidence fingerprint.

The model performs one small, fast, non-streaming structured generation.

```ts
const NameProposalSchema = z.object({
  workspaceId: z.string(),
  areaId: z.string().nullable(),
  task: z.string(),
  taskDecision: z.enum(["keep", "replace"]),
  confidence: z.number().min(0).max(1),
});
```

Post-validation must:

- require returned IDs to exist in the supplied candidates;
- preserve the full Name Record without plugin-side truncation; visible statusline
  truncation remains a native tmux-format and user-layout concern;
- reject control characters and escape sequences;
- reject empty, answer-shaped, or refusal-shaped Task values;
- preserve the previous Task when `taskDecision` is `keep`;
- treat malformed or low-confidence results as inference failure.

AI never returns the final rendered window name.

**Token and cost envelope.** Token counts depend on the provider and model
tokenizer and are not a protocol guarantee. In the local AI SDK transport
fixture, a typical evidence prompt was 1,449 UTF-8 bytes, estimated at 400-700
input tokens. A full 8 KiB terminal-context fixture produced a 9,517-byte
prompt, estimated at 2,500-5,000 input tokens. Candidate and path data vary,
and providers may account for the structured-output schema separately. Model
output is capped at 64 tokens. At the default per-window quota, the typical
upper estimate is 2,400-4,200 input tokens per hour; an all-full-capture case
is about 15,000-30,000.

## 12. State and stale-result fencing

```ts
type WindowState = {
  mode: "automatic" | "manual";
  revision: number;
  fingerprint?: string;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  manualName?: string;
  lastAppliedName?: string;
};
```

An inference result is accepted only when:

- its tmux server and window still exist;
- its window ID matches;
- its revision is current;
- its evidence fingerprint is current;
- the window remains in automatic mode.

Cancellation is an optimization. Revision and fingerprint checks provide the
correctness guarantee.

State needed to recover manual ownership and the last accepted Name Record may
be stored in tmux window user options. Raw evidence, prompts, pane output, and
resolved credentials are never persisted. No database is required.

Bounded automatic-call timestamps and circuit-breaker state are stored as
numeric tmux user-option metadata so daemon restart cannot reset quotas or the
cooldown. They contain no prompt, path, model response, or credential data.

## 13. Manual ownership

Manual Name always wins.

- A user-originated non-empty `rename-window` enters manual mode.
- Plugin-originated renames are guarded and do not enter manual mode.
- `tmux rename-window ""` or `tmux-autoname auto` restores automatic mode.
- Entering manual mode increments the revision and invalidates all in-flight
  model results.
- Automatic Name may continue to be computed internally only if doing so does
  not create model calls; no visible write occurs while manual mode is active.

## 14. Failure and fallback

- A new window immediately receives a deterministic provisional name from
  Scope and Activity, with no invented Task.
- While AI is running, the provisional or last-known-good name remains visible.
- On AI failure, an existing accepted name is retained.
- On tmux write failure, semantic state remains retryable and the shell remains
  unaffected.
- Missing daemon, model, network, password manager, or optional adapter never
  blocks tmux or a shell command.

## 15. Window-tab badges

Badges are separate from the window name and Name Record.

```tmux
set -g @tmux-autoname-badge-style 'plain' # default
set -g @tmux-autoname-badge-style 'nerd'
```

| State | Plain | Nerd |
|---|---:|---:|
| Generating | `…` | `󰚩` |
| Failed | `!` | `` |
| Secret unavailable | `K!` | `` |
| Manual | `M` | `` |
| Healthy | empty | empty |

The plugin exposes a window-scoped badge option for use in
`window-status-format` and `window-status-current-format`. By default,
installation appends the conditional badge fragment idempotently without
replacing the user's existing formats. Users may disable this behavior and add
the fragment manually. Invalid badge styles fall back to `plain`.

There is no popup or TUI. Detailed information is available through
`tmux-autoname explain`.

## 16. Model provider and credentials

v3.0 includes three AI SDK providers:

- `openai` for the native OpenAI API;
- `anthropic` for the native Anthropic API;
- `openai-compatible` for compatible cloud or local endpoints.

Provider and model are both required configuration. There is no implicit
provider, default model, gateway, or automatic provider fallback. A compatible
provider additionally requires an explicit base URL. This keeps routing,
privacy, and billing decisions visible to the user.

Configuration stores a reference, never a literal API key.

```json
{
  "source": "onepassword",
  "ref": "op://Private/OpenAI/api-key"
}
```

```json
{
  "source": "keyring",
  "service": "tmux-autoname",
  "account": "openai"
}
```

```json
{
  "source": "env",
  "name": "OPENAI_API_KEY"
}
```

Resolvers:

- 1Password: `op read --no-newline <reference>`.
- Linux keyring: exact-attribute `secret-tool lookup`.
- macOS Keychain: exact service/account lookup through `security`.
- Environment: only the explicitly named variable.

Rules:

- Resolve lazily on the first model call.
- Cache in daemon memory for the daemon session.
- Clear on daemon exit, explicit secret reload, or provider 401/403.
- Never place resolved values in tmux options, argv, logs, state files, prompts,
  or crash reports.
- Background resolution must not open an interactive terminal prompt. Failure
  sets the secret-unavailable badge and waits for explicit retry.

## 17. User-facing commands

```text
tmux-autoname daemon    internal daemon lifecycle
tmux-autoname emit      internal tmux/shell event input
tmux-autoname refresh   request immediate inference within quota
tmux-autoname auto      clear Manual Name and resume automation
tmux-autoname explain   print current record, state, and safe diagnostics
tmux-autoname secrets reload
                        restart the daemon and reload config/credentials
```

Only explicitly invoked diagnostic commands may write to the user's terminal.

## 18. Test strategy

### 18.1 Real isolated E2E

E2E tests run against an isolated tmux server and never modify the user's tmux
server or configuration:

```sh
tmux -L tmux-autoname-e2e -f /dev/null
```

The test runs the compiled release binary, daemon, Unix socket, bounded terminal
capture, zsh integration, tmux hooks, and a local OpenAI-compatible HTTP test
server. The local server keeps AI SDK transport and structured-output handling
real while providing deterministic responses, delays, failures, request counts,
and payload capture.

The suite covers window creation, Scope changes, Activity changes,
terminal-context generation, manual rename and restore, badges, daemon restart,
secret failure, timeouts, out-of-order results, stale-result rejection, rate
limits, and circuit breaker recovery. Automatic paths are also checked for
empty stdout and stderr.

### 18.2 Accelerated long-duration simulation

Scheduling, quotas, and circuit-breaker logic use an injectable clock. Tests
advance logical time to simulate at least 24 hours of window switches, content
changes, cwd changes, failures, and quota-window resets without waiting 24
wall-clock hours. Event volume is high enough to expose unbounded state, timer,
request, and descriptor accumulation.

### 18.3 Real-time soak test

A release candidate runs a 30-minute real-time soak test against the isolated
tmux server. It records CPU, RSS, open file descriptors, child processes, socket
health, event count, AI request count, and payload sizes. The test fails on a
daemon crash, lost responsiveness, leaked child processes or descriptors,
unbounded memory growth, quota violations, terminal output, or tmux blockage.

A real paid-provider request is an opt-in smoke test only. It is excluded from
normal automated tests and CI. Plain and Nerd badge strings are checked
automatically; final Nerd Font appearance receives one manual visual check.

No 24-hour wall-clock test is required.

## 19. Acceptance criteria

1. Automatic hook execution never enters tmux view mode and never requires
   Enter to continue.
2. A `partjobs` session can retain `partjobs` as Workspace while representing a
   nested child project and subdirectory as Area.
3. Task is generated from settled active-pane content without any Agent
   extension; unchanged content produces no additional model call.
4. Switching windows with unchanged evidence produces no model call.
5. Reversed completion order for two model requests cannot apply the older
   result.
6. A late model result cannot overwrite a Manual Name.
7. AI, provider, network, and credential failure preserve a useful existing or
   provisional name.
8. Profile and badge-style changes require no model call.
9. Plain and Nerd Font badges render the same underlying state.
10. No plaintext provider secret is stored in configuration, tmux options,
    persistent state, or logs.
11. A successfully resolved credential is reused for the daemon session without
    repeated password-manager prompts.
12. Multi-pane windows use the active pane for Activity and do not allow an
    inactive pane to rename the window independently.
13. Every AI-generated Task is a short English action phrase.
14. Terminal evidence is bounded, redacted before transport, and absent from
    tmux options, persistent state, and logs.
15. Inference, including explicit refresh, never exceeds six calls per window
    or thirty calls per tmux server in one hour.
16. Three consecutive inference failures suspend automatic calls for ten
    minutes without affecting tmux operation.
17. The isolated real E2E suite, accelerated 24-hour logical-time simulation,
    and 30-minute real-time soak test all pass before release.
