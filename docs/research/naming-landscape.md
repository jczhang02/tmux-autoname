# Naming landscape and v3 recommendation

Research date: 2026-08-21

## Question

Which existing tmux, terminal, shell-integration, coding-agent, and AI-title
designs are worth borrowing for an AI-first tmux window naming plugin?

## Findings

### Deterministic tmux and shell namers

[`ofirgall/tmux-window-name`](https://github.com/ofirgall/tmux-window-name)
classifies foreground programs and finds the shortest path suffix that
distinguishes windows. Shells render as a path, selected programs such as
`nvim` and `git` render as program plus path, and other programs render as the
command. It preserves manual names by disabling automatic renaming until the
name is cleared.

[`MikeDacre/tmux-zsh-vim-titles`](https://github.com/MikeDacre/tmux-zsh-vim-titles)
uses shell hooks and editor autocmds rather than polling. It abbreviates home,
limits path width, and updates Vim titles from buffer changes. Its documentation
also demonstrates the bad UX of continuously overwriting manual names.

[`mbenford/zsh-tmux-auto-title`](https://github.com/mbenford/zsh-tmux-auto-title)
uses command/idle transitions and a short idle delay. Its idle fallback keeps a
useful title visible rather than immediately replacing it after command exit.

[`brendandebeasi/tabby`](https://github.com/brendandebeasi/tabby) uses a daemon
for richer cross-window state, AI-tool detection, activity indicators, and
persistent interaction. It includes an ASCII fallback when Nerd Fonts are not
available.

Lessons:

- Reuse shortest-distinguishing paths as deterministic Scope candidates.
- Prefer event hooks to polling.
- Keep manual ownership as an explicit state.
- Keep plain and Nerd Font badge sets.
- A daemon is justified only by cross-pane aggregation, asynchronous AI,
  credential caching, and stale-result fencing—not ordinary process titles.

### Terminal and shell semantic signals

- [OSC 7](https://wezterm.org/shell-integration.html) reports cwd as a file URL.
- [OSC 133](https://github.com/kovidgoyal/kitty/blob/master/docs/shell-integration.rst)
  marks prompt start, command start, command completion, and exit status.
- [VS Code OSC 633](https://code.visualstudio.com/docs/terminal/shell-integration)
  adds exact command and cwd fields, with an optional anti-spoofing nonce.
- [OSC 0/1/2](https://www.xfree86.org/current/ctlseqs.html) carries application
  titles, but the text is arbitrary and therefore only a low-confidence hint.
- tmux passthrough is optional and visibility-sensitive, so parsing raw terminal
  escape streams is not a dependable core interface.

Lessons:

- Borrow the command lifecycle represented by OSC 133, but initially receive it
  through explicit shell hooks rather than parsing pane output.
- Treat cwd, command boundaries, exit status, and program identity as facts.
- Treat application/pane titles as hints.
- Do not continuously capture or stream pane output.

### Coding-agent hooks

- [Claude Code hooks](https://code.claude.com/docs/en/hooks) expose structured
  `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, and notification
  events with session id, cwd, and prompt data.
- [OpenAI Codex hooks](https://developers.openai.com/codex/hooks) expose prompt,
  session, stop, tool, permission, and subagent lifecycle events. The transcript
  format is not a stable interface.
- [Gemini CLI hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
  expose structured session and before/after-agent events.
- [OpenCode plugins](https://opencode.ai/docs/plugins/) expose session lifecycle,
  idle/status, message, permission, and error events.
- [Pi extensions and SDK](https://pi.dev/docs/latest/extensions) expose session,
  agent-loop, message, and session-info events; Pi also has documented
  [SDK](https://pi.dev/docs/latest/sdk),
  [session format](https://pi.dev/docs/latest/session-format), and
  [RPC](https://pi.dev/docs/latest/rpc).

Lessons:

- Structured agent hooks are the highest-quality Task evidence.
- Normalize them into a small internal event vocabulary; do not parse rendered
  terminal text or undocumented transcript formats.
- Agent adapters are optional. Core naming must still work with tmux/process
  facts alone.
- Raw prompts are sensitive. Enabling an agent adapter must be an explicit
  privacy choice, and only the derived Task should be persisted.

### AI-generated title systems

[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent/blob/main/agent/title_generator.py)
creates an immediate deterministic title from the first user message, then does
one asynchronous small-model upgrade. It caps input and output, uses constrained
JSON, and orders provenance as derived below LLM below user.

[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
supports first-prompt or all-prompt title modes. Its title provider receives a
message snapshot and `AbortSignal`, and returns source-message sequence numbers
so stale titles can be rejected.

[`QwenLM/qwen-code`](https://github.com/QwenLM/qwen-code) distinguishes automatic
and manual title sources and supports explicit automatic regeneration. Its issue
history also demonstrates why arbitrary recent-context tails can displace the
actual user prompt and produce bad titles.

Lessons:

- Default to the first eligible human prompt in an agent session.
- Use one small, fast, non-streaming structured generation.
- Persist provenance: `fallback`, `ai`, or `manual`.
- Manual always wins; a newer revision invalidates older requests.
- Bound input and display width, and reject refusal- or answer-shaped titles.
- Do not generate on every prompt by default.

## Recommended v3 architecture

### Runtime

- TypeScript strict mode, Bun, Vercel AI SDK, and Zod.
- One quiet daemon per tmux server, plus a small TPM loader and event command.
- Hooks send stable tmux IDs to the daemon over a Unix socket and return
  immediately. No polling and no stdout on automatic paths.
- Start with tmux hooks and explicit shell/agent hooks. Do not start with tmux
  control mode or continuous pane-output capture.

### Evidence priority

1. Explicit manual name.
2. Structured coding-agent event or existing agent session title.
3. Shell command-boundary event with cwd and exit status.
4. tmux/process/git/path metadata.
5. Pane title as a low-confidence hint.
6. Bounded pane capture only when explicitly enabled.

The active pane controls Activity. Other panes contribute supporting Scope and
Task evidence but do not independently rename the shared window.

### Semantic pipeline

1. Snapshot the window and build deterministic Workspace, Area, and Activity
   candidates.
2. Render an immediate provisional name from Scope and Activity if no previous
   AI record exists.
3. On the first eligible semantic event, send bounded evidence plus the previous
   Name Record to the model.
4. AI selects Scope candidate IDs and generates only the stable Task text.
5. Accept a result only when window id, revision, evidence fingerprint, and
   automatic/manual mode still match.
6. Render the accepted Name Record through the configured Display Profile.

Suggested structured result:

```json
{
  "workspaceId": "candidate-1",
  "areaId": "candidate-3",
  "task": "redesign naming engine",
  "taskDecision": "replace",
  "confidence": 0.91
}
```

Activity remains deterministic. AI may select only supplied Scope candidates;
it may not invent paths or process identities.

### Trigger policy

- Generate once for the first human prompt of each agent session.
- Generate when a new agent session starts in the same window.
- For a generic shell, generate after a meaningful command completes or Scope
  changes, not for each line of output.
- Allow explicit `tmux-autoname refresh`.
- Use about one second of debounce, one request in flight per window, a
  per-window cooldown, a short timeout, and no automatic retry storm.
- Window selection alone only refreshes local evidence; it does not call AI when
  the fingerprint is unchanged.

### Ownership and failure

- `manual` names are never overwritten. Clearing the name or running
  `tmux-autoname auto` restores automation.
- On model failure, retain the last accepted AI name. A new window keeps its
  deterministic provisional name.
- Window-tab badges show generating, failed, secret-unavailable, and manual
  states. Plain and Nerd Font sets are configurable; healthy state is hidden.
- Detailed diagnostics are available through `tmux-autoname explain`; no popup
  or TUI is required.

### Privacy and credentials

- Never send environment variables, secrets, full scrollback, or unbounded
  command output.
- Agent adapters are explicit opt-in because prompts may be transmitted.
- Persist only the Name Record and provenance, never raw prompts or pane output.
- Provider credentials use secret references and session-scoped in-memory
  caching as documented in
  [`secret-loading.md`](./secret-loading.md).

