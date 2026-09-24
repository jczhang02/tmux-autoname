# tmux-autoname v3 Specification

Status: accepted implementation baseline. Supersedes v3 with
[ADR 0001](./docs/adr/0001-stable-window-work-labels.md),
[ADR 0002](./docs/adr/0002-work-label-inference-policy.md), and
[ADR 0003](./docs/adr/0003-work-label-display-and-migration.md), all Accepted
and implemented.

## 1. Purpose

tmux-autoname assigns stable, useful names to tmux windows. It combines
deterministic terminal facts with AI-generated task semantics while preserving
manual user control and never blocking normal terminal use.

The semantic vocabulary is defined in [`CONTEXT.md`](./CONTEXT.md). Research
supporting this specification is recorded in
[`docs/research/naming-landscape.md`](./docs/research/naming-landscape.md) and
[`docs/research/secret-loading.md`](./docs/research/secret-loading.md).

## 2. Goals

- Produce names from `Scope + Task`.
- Use AI as the sole generator of Task and as the selector of ambiguous Scope
  boundaries.
- Support nested workspaces such as a `partjobs` session whose active pane is in
  `high-value-patent-rebuild/manuscript`; the name still reflects only the
  `partjobs` Workspace, since the nested child project and subdirectory are not
  part of Scope.
- Work with every terminal program without Agent-specific extensions, hooks, or
  APIs.
- Keep automatic tmux paths silent and non-blocking.
- Preserve manual names until the user explicitly restores automation.
- Preserve an accepted Task once assigned: automation may establish it but
  never silently replace it.
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
};

type NameRecord = {
  scope: Scope;
  task: string;
};
```

Responsibilities:

- **Scope**: local code discovers candidates; AI selects among candidates when
  the boundary is ambiguous. Scope is a Workspace only ([ADR 0003](./docs/adr/0003-work-label-display-and-migration.md));
  cwd-driven subdirectories (formerly Area) are never part of it.
- **Task**: generated only by AI. It represents the stable user goal, not the
  latest command.
- **Activity**: the active pane's foreground process, determined locally. It
  is live diagnostic information available through `explain` and as model
  evidence; it is not part of the Name Record and never appears in the
  rendered name ([ADR 0003](./docs/adr/0003-work-label-display-and-migration.md)).
- **Display Profile**: renders a Name Record; it does not change semantics.

The default Display Profile is:

```text
{scope}/{task}
```

`scope` renders as `workspace`. Empty components and their adjacent separators
are omitted. A profile change re-renders the existing record without calling
AI. A custom profile containing `{activity}` is not silently rewritten: it
receives an actionable diagnostic (surfaced in `explain` and the diagnostic
log) and renders with the default profile until the user removes `{activity}`
from it; see section 19 (Migration) below.

Task is always a concise English action slug: two to five lower-case words
joined by hyphens, with no other punctuation.

## 5. Runtime and dependencies

- TypeScript with strict mode.
- Bun for development, tests, and standalone builds.
- Vercel AI SDK for provider-independent model calls.
- Zod for configuration and structured model-output validation.
- A small TPM shell loader for installation and tmux hooks.
- One daemon per tmux server.
- A Unix socket under `XDG_RUNTIME_DIR` for local event delivery.
- A build identity in daemon pings; a launcher replaces a daemon from an older
  build before sending events.

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
 revision/fingerprint/manual/acceptance gate
              |
              v
         Display Profile
              |
              v
      tmux rename-window
```

The daemon hides event coalescing, snapshot collection, process inspection,
candidate generation, model calls, revision fencing, Task-acceptance tracking,
manual ownership, rendering, credential caching, and tmux writes.

The implementation uses tmux hooks, optional shell events, and a low-frequency
monitor. Lightweight process/path signals cover all panes so inactive windows
converge after startup and process changes. Rendered text is captured only
from the active pane of a Window that is the current window of at least one
attached client ([ADR 0002](./docs/adr/0002-work-label-inference-policy.md),
D2); an explicit `refresh` is the one exception (section 10). After the screen
is unchanged for the settle period, the runtime captures at most 50 lines and
8 KiB for one inference. It does not use tmux control mode, stream pane
output, or install Agent extensions.

## 7. Evidence hierarchy

Evidence is considered in this order:

1. Explicit Manual Name.
2. Bounded rendered text from the active pane after it settles.
3. Shell command lifecycle event with cwd and exit status when available.
4. tmux, process, git, and path metadata.
5. Pane title as a low-confidence hint.

The active pane controls Activity. Other panes may contribute Scope and Task
evidence through local tmux/git/path metadata only; their rendered text is
never read, and no pane can independently rename the shared window.

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
- stable common ancestors.

A session root is trusted as Workspace when its basename matches the session
name and it contains the active cwd. This preserves deliberate `sesh` project
containers such as `partjobs`. Otherwise the active Git/worktree root is the
preferred local Workspace, preventing a generic session path such as `$HOME`
from producing `project/dev/project`. A session name and raw cwd remain evidence,
not automatic Scope.

Each candidate has an opaque ID, label, kind, and grounded path or host facts.
AI may select a compatible candidate ID but may not return an arbitrary or
ungrounded workspace.

This selection order applies only before a Task is accepted: the provisional
Workspace may follow Workspace changes but never a subdirectory change within
a Workspace. Once a Task is accepted, its Workspace affiliation is fixed and
is never re-derived from fresh candidates, even if a later snapshot's
candidates would ground it differently
([ADR 0002](./docs/adr/0002-work-label-inference-policy.md)).

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
Activity  = codex
```

(The active pane's actual work -- the nested `high-value-patent-rebuild`
project and its `manuscript` subdirectory -- informs the Task the model
proposes, but is not itself part of Scope; see section 4.)

## 9. Normalized events

The daemon accepts a small event vocabulary:

```ts
type SemanticEventKind =
  | "command_started"
  | "command_finished"
  | "content_settled"
  | "window_changed"
  | "manual_name_changed"
  | "refresh_requested"
  | "new_work_requested";
```

`refresh_requested` drives the `refresh` command (re-identification);
`new_work_requested` drives the `new` command (New Work); see section 17.

The core tmux integration emits bounded JSON through the Unix socket. The zsh
lifecycle integration is optional and sends only command basenames and exit
codes. Secrets and terminal text never appear in argv. There are no
Agent-specific adapters or extension installation paths.

## 10. AI trigger policy

**Once a Task is accepted, automation may establish it but never silently
replace it again** ([ADR 0001](./docs/adr/0001-stable-window-work-labels.md)).
Workspace changes, directory changes, activity changes, and process exit are
never triggers for an accepted window; only an explicit `refresh` (kept as an
override; see below) can run inference again, and it retains the old label
unless a replacement is accepted.

Before a Task is accepted, AI generation occurs when:

- the active pane's bounded rendered content changes and then settles;
- the local Workspace guess changes (a subdirectory change within the same
  Workspace never triggers);
- a meaningful generic-shell command completes and no stable Task exists;
- the user explicitly runs `tmux-autoname refresh` (also valid on an accepted
  window, as the one exception above).

AI generation does not occur merely because:

- a window or pane is selected;
- an individual terminal output chunk arrives or the screen is still changing;
- Activity changes while Scope and Task remain valid;
- an evidence fingerprint is unchanged;
- elapsed time alone has passed, or output has merely repeated.

Fingerprint normalization removes duplicate prompt redraws and low-information
shell chrome without changing the bounded terminal evidence sent to the model.

`tmux-autoname new` (New Work) discards the window's Task, shows a
Workspace-only Provisional Name, and records the current evidence fingerprint
as a baseline; no automatic inference runs while the fingerprint still equals
that baseline, so residual on-screen content from the discarded Task cannot by
itself trigger a fresh attempt ([ADR 0002](./docs/adr/0002-work-label-inference-policy.md),
resolved question "Evidence boundary after `new`"). It refuses in manual mode
and does not reset quotas.

Initial internal defaults:

```text
debounce                 1000 ms
active-pane scan          3000 ms
content settle            4000 ms
minimum call interval    60000 ms per window
in-flight requests      1 per window
request timeout        15000 ms
automatic model retries 0
automatic calls          6 per window per hour
automatic calls         30 per tmux server per hour
failure circuit opens    after 3 consecutive failures
failure circuit cooldown 10 minutes
```

A forced refresh bypasses fingerprint deduplication and the minimum interval,
but not manual ownership, request validation, hourly quotas, or the circuit
breaker. The command waits for a final applied/failed/blocked outcome rather
than returning at scheduling time. Every provider request -- a proposal, a
keep, an abstention, or a failure -- is charged against the same quotas. When a
quota or circuit breaker blocks inference, the last-known-good or deterministic
fallback name remains active.

Revision and fingerprint fencing (section 12) discards a stale in-flight
result: `new`, manual rename, and refresh each increment the revision. Once a
Task is accepted, any other in-flight automatic request for that window is
also discarded when it completes, since automation may not replace an
accepted Task ([ADR 0002](./docs/adr/0002-work-label-inference-policy.md),
resolved question "Stale in-flight inference").

## 11. AI request and result

The request contains only bounded evidence:

- previous Name Record and provenance;
- Scope candidates and IDs;
- deterministic Activity;
- active-pane cwd, command, and title;
- the active pane's redacted rendered tail, capped at 50 lines and 8 KiB;
- active pane structured event;
- short supporting-pane metadata (tmux/git/path facts only, never rendered
  text);
- window ID, revision, and evidence fingerprint.

The model performs one small, fast, non-streaming structured generation. It
must return exactly one of three outcomes
([ADR 0002](./docs/adr/0002-work-label-inference-policy.md), D5):

```ts
const NameProposalSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("propose"),
    workspaceId: z.string(),
    task: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  z.object({ outcome: z.literal("keep") }),
  z.object({ outcome: z.literal("abstain") }),
]);
```

- `propose` offers a Workspace selection, a Task, and a model-reported
  confidence.
- `keep` asks to retain the previous Task; it is only meaningful on an
  explicit `refresh` with a previous Task to keep, and resolves to abstention
  otherwise.
- `abstain` is a normal outcome, not an error: the model had insufficient or
  ambiguous evidence.

Post-validation must:

- require a returned workspace ID to exist in the supplied candidates;
- preserve the full Name Record without plugin-side truncation; visible statusline
  truncation remains a native tmux-format and user-layout concern;
- reject control characters and escape sequences;
- deterministically repair a Task before validating it -- lowercase, strip
  stray punctuation, collapse whitespace/hyphen runs
  ([ADR 0002](./docs/adr/0002-work-label-inference-policy.md), D7) -- rather
  than failing on a minor formatting slip;
- treat a refusal-shaped, empty, or still-invalid-after-repair Task, an
  ungrounded workspace ID, or a below-threshold confidence as abstention, not
  a request failure;
- treat a `propose` below the configured `confidence_threshold` (default 0.6)
  as abstention.

Abstention and `keep` are excluded from the failure circuit (section 14);
only an actual request failure counts toward it.

AI never returns the final rendered window name.

**Token and cost envelope.** Token counts depend on the provider and model
tokenizer and are not a protocol guarantee. In the local AI SDK transport
fixture, a typical evidence prompt was estimated at 250-500
input tokens. A full 8 KiB terminal-context fixture produced a 9,517-byte
prompt, estimated at 2,500-5,000 input tokens. Candidate and path data vary,
and provider accounting varies. Model output is capped at 512 tokens so
reasoning-capable compatible models can finish; generation stops after the
small JSON object, so the cap is not fixed consumption. At the default
per-window quota, the typical upper estimate is 1,500-3,000 input tokens per
hour; an all-full-capture case
is about 15,000-30,000.

## 12. State and stale-result fencing

```ts
type WindowState = {
  mode: "automatic" | "manual";
  revision: number;
  fingerprint?: string;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  // ADR 0001: once true, the Task is accepted and automation may never
  // replace it again; only an explicit `refresh` or `new` may.
  accepted?: boolean;
  // The accepted proposal's model-reported confidence (0-1); surfaced in
  // `explain`, diagnostic only, not part of the Name Record's durable
  // meaning.
  confidence?: number;
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
correctness guarantee. Once a Task is accepted, automatic model calls stop
entirely for that window (section 10); only an explicit `refresh` can produce
a new in-flight request to fence.

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
  These are the *only* actions that unlock a Manual Name: neither
  re-identification (`refresh`) nor New Work (`new`) implicitly restores
  automation ([ADR 0001](./docs/adr/0001-stable-window-work-labels.md)).
- Entering manual mode increments the revision and invalidates all in-flight
  model results.
- Automatic Name may continue to be computed internally only if doing so does
  not create model calls; no visible write occurs while manual mode is active.
- `new` refuses outright in manual mode and asks the user to restore
  automation first, rather than silently doing nothing.

## 14. Failure and fallback

- A new window immediately receives a deterministic provisional name from
  Scope, with no invented Task.
- While AI is running, the provisional or last-known-good name remains visible.
- Missing AI configuration, insufficient evidence (quota, circuit, minimum
  interval, or dedup), and abstention are normal outcomes, not error badges;
  `explain` describes the reason and the next action. Abstention still
  consumes quota but is excluded from the failure circuit
  ([ADR 0002](./docs/adr/0002-work-label-inference-policy.md)).
- On an actual request failure (timeout, malformed response, provider error),
  the existing name is retained and an error badge is shown. A network
  failure does not automatically resend identical evidence.
- Authentication or credential failure pauses further *automatic* attempts
  (server-wide, since the credential is shared) until an explicit `refresh` or
  `tmux-autoname secrets reload`; ordinary quota and circuit protections still
  apply. A provider 401/403 also clears the cached credential.
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
| Failed | `!` | `` |
| Secret unavailable | `K!` | `` |
| Manual | `M` | `` |
| Healthy | empty | empty |

The plugin exposes a window-scoped badge option for use in
`window-status-format` and `window-status-current-format`. By default,
installation appends the conditional badge fragment idempotently without
replacing the user's existing formats. Users may disable this behavior with
`@tmux-autoname-install-badge 'off'` and add the fragment manually. Invalid
badge styles fall back to `plain`.

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
privacy, and billing decisions visible to the user. A `confidence_threshold`
(default 0.6) is also configurable; a `propose` outcome below it resolves to
abstention (section 11).

Configuration accepts exactly one of a plaintext `api_key` or a credential
reference. Plaintext is the simplest setup but remains on disk, so the README
must tell users to restrict the configuration file to their account. Credential
references remain the recommended option for password-manager and system-keyring
integration.

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
- Explicit secret reload closes the authentication failure circuit but
  preserves hourly call timestamps and quotas.
- An authentication failure pausing further automatic attempts (section 14)
  is resolved the same two ways: an explicit `refresh` (which bypasses the
  pause for that one request and clears it on success) or
  `tmux-autoname secrets reload`.
- Never place resolved values in tmux options, argv, logs, state files, prompts,
  or crash reports.
- Background resolution must not open an interactive terminal prompt. Failure
  sets the secret-unavailable badge and waits for explicit retry.

## 17. User-facing commands

```text
tmux-autoname daemon    internal daemon lifecycle
tmux-autoname emit      internal tmux/shell event input
tmux-autoname refresh   re-identification: wait for immediate inference and
                         print its outcome; keeps the old label until a
                         replacement is accepted, including on failure or
                         abstention
tmux-autoname new       New Work: discard the window's Task, show a
                         Workspace-only name, and wait for changed evidence
                         before inferring again; refuses in manual mode
tmux-autoname auto      clear Manual Name and resume automation
tmux-autoname explain   print a human explanation (`--json` for structured
                         data), including the accepted proposal's confidence
tmux-autoname secrets reload
                        restart the daemon and reload config/credentials
```

`refresh`, `new`, `auto`, and `explain` accept `--window @ID` or `--pane %ID`;
inside tmux they otherwise target the current pane. `refresh` and `explain`
also accept `--json`. Optional key bindings (`@tmux-autoname-key-refresh`,
`@tmux-autoname-key-auto`, `@tmux-autoname-key-new`) can bind each command to
a key in the `prefix` table, reporting the result through tmux's status-line
message; none is bound by default.

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
terminal-context generation, manual rename and restore, Task acceptance and
its lifecycle (`new`, `refresh`, persistence across daemon restart), badges,
daemon restart, stale-daemon replacement, secret failure, timeouts,
out-of-order results, stale-result rejection, rate limits, and circuit breaker
recovery. Automatic paths are also checked for empty stdout and stderr.

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

### 18.4 Offline naming-quality eval

`bun run eval` (`test/eval/run.ts`) scores the model configured in the user's
own `config.toml` against realistic evidence fixtures under
`test/eval/fixtures/`: validity of the returned Task, keyword match against
each fixture's expected Task, abstention correctness, and stability of the
outcome across near-duplicate evidence. It is opt-in, gated on
`TMUX_AUTONAME_RUN_EVAL=1`, calls a real configured provider, and never runs
as part of `bun run test` or CI, like the soak test. `bun run test` only
checks that the fixtures parse and the prompt builder handles them.

## 19. Migration

On upgrade, a pre-ADR-0003 persisted Window state (Scope with an optional
Area, NameRecord with Activity, unversioned) is decoded once
(`decodePersistedWindowState`). A legacy record with a valid Task and AI
provenance becomes an accepted label without a new AI request; its Workspace
affiliation is retained, and Activity/Area are dropped since they no longer
exist. A legacy Task that is not valid, even after the same deterministic
repair used for model output (section 11), is dropped rather than guessed at,
leaving the window to start fresh with a Workspace-only Provisional Name on
the next automatic update; this never overwrites whatever name is currently
visible. Manual Names pass through untouched. Completely unparseable state is
treated identically to no persisted state at all.

The built-in default Display Profile changes from `{activity}:{scope}/{task}`
to `{scope}/{task}`. A `@tmux-autoname-profile` left exactly at the old
built-in default migrates silently on plugin load. A genuinely customized
template that contains `{activity}` is never silently rewritten: it receives
the diagnostic described in section 4 instead.

Release notes, README.md, and README.zh-CN.md disclose this one-time display
change and the removal of Area.

## 20. Acceptance criteria

1. Automatic hook execution never enters tmux view mode and never requires
   Enter to continue.
2. A `partjobs` session retains `partjobs` as Workspace, whether the active
   pane is at the session root or several subdirectories below it; the name
   does not change with the subdirectory.
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
10. A plaintext provider secret is stored only when the user explicitly selects
    `api_key`; provider secrets never appear in tmux options, persistent state,
    logs, prompts, or diagnostics.
11. A successfully resolved credential is reused for the daemon session without
    repeated password-manager prompts.
12. Multi-pane windows use the active pane for Activity and evidence text; an
    inactive pane never contributes rendered text and cannot rename the window
    independently.
13. Every AI-generated Task is a short English action slug with hyphen-separated words.
14. Terminal evidence is bounded, redacted before transport, and absent from
    tmux options, persistent state, and logs.
15. Inference, including explicit refresh, never exceeds six calls per window
    or thirty calls per tmux server in one hour.
16. Three consecutive inference failures suspend automatic calls for ten
    minutes without affecting tmux operation. Abstention never counts toward
    this circuit.
17. Once a Task is accepted, no Workspace, directory, activity, or process-exit
    change replaces it automatically; only an explicit `refresh` (keeping the
    old label unless a replacement is accepted) or `new` (discarding it)
    changes it.
18. `new` leaves a Workspace-only Provisional Name and does not re-infer from
    residual on-screen content until the evidence fingerprint changes from its
    post-`new` baseline.
19. An explicit `refresh` targeting a hidden window still reads only that
    window's active pane, bounded exactly as a visible read would be.
20. The isolated real E2E suite, accelerated 24-hour logical-time simulation,
    and 30-minute real-time soak test all pass before release.
