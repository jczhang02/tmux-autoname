import type { AppConfig } from "./config";
import {
  badgeText,
  buildScopeCandidates,
  deterministicScope,
  evidenceFingerprint,
  isGroundedScope,
  isMeaningfulCommand,
  normalizeActivity,
  normalizeTask,
  renderName,
  resolveDisplayProfile,
  resolveProposal,
  type BadgeState,
  type BadgeStyle,
  type DisplayProfileDiagnostic,
  type NameProposal,
  type NameRecord,
  type NameRequest,
  type PersistedServerState,
  type PersistedWindowState,
  type SemanticEvent,
  type TmuxPane,
  type TmuxWindowSnapshot,
} from "./domain";

const CURRENT_PERSISTED_VERSION = 2 as const;

export type TmuxTarget = { windowId?: string; paneId?: string };

export interface TmuxPort {
  snapshot(target: TmuxTarget): Promise<TmuxWindowSnapshot>;
  activePanes(): Promise<string[]>;
  capturePane(paneId: string): Promise<string>;
  rename(windowId: string, name: string): Promise<void>;
  persist(windowId: string, state: PersistedWindowState): Promise<void>;
  persistServer(state: PersistedServerState): Promise<void>;
  setBadge(windowId: string, badge: string): Promise<void>;
}

export interface ModelPort {
  propose(request: NameRequest, signal: AbortSignal): Promise<NameProposal>;
  clearCredential(): void;
}

export interface ClockPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class RealClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, delayMs);
  }

  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

export class SecretUnavailableError extends Error {
  constructor(message = "provider credential is unavailable") {
    super(message);
    this.name = "SecretUnavailableError";
  }
}

export class ProviderAuthenticationError extends Error {
  constructor(message = "provider authentication failed") {
    super(message);
    this.name = "ProviderAuthenticationError";
  }
}

type RuntimeWindowState = PersistedWindowState & {
  fingerprint?: string;
  // ADR 0002: only Workspace-level changes are a trigger before a Task is
  // accepted; subdirectory changes within a Workspace never are (Scope has
  // no Area to track separately -- see ADR 0003).
  lastLocalWorkspace?: string;
  lastProfile: string;
  // D6: set when `lastProfile` above is a fallback because the configured
  // template contains {activity}; surfaced in `explain` and the diagnostic
  // log, and re-evaluated (and re-logged on change) on every snapshot.
  displayDiagnostic?: DisplayProfileDiagnostic;
  badgeStyle: BadgeStyle;
  badgeState: BadgeState;
  badgeSynced: boolean;
  pluginNames: string[];
  lastCallAt?: number;
  callTimes: number[];
  pendingTimer?: unknown;
  inFlight?: AbortController;
  lastError?: string;
};

export type RuntimeOutcome = {
  kind: "applied" | "scheduled" | "manual" | "ignored" | "failed";
  windowId: string;
  reason?: string;
  name?: string;
};

export type ExplainReport = {
  windowId: string;
  mode: "automatic" | "manual";
  revision: number;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  accepted: boolean;
  // the accepted proposal's model-reported confidence (0-1);
  // diagnostic only, not part of the Name Record's durable meaning.
  confidence?: number;
  manualName?: string;
  visibleName: string;
  badge: { state: BadgeState; text: string; style: BadgeStyle };
  fingerprint?: string;
  lastError?: string;
  // Live information derived from the current snapshot's active pane, never
  // part of the Name Record (ADR 0003); diagnostic only.
  liveActivity?: string;
  displayDiagnostic?: DisplayProfileDiagnostic;
  limits: {
    windowCallsLastHour: number;
    windowCallLimit: number;
    serverCallsLastHour: number;
    serverCallLimit: number;
    circuitOpenUntil?: number;
  };
};

const HOUR_MS = 60 * 60 * 1000;
const MAX_RUNTIME_WINDOWS = 256;

export class AutonameRuntime {
  readonly #tmux: TmuxPort;
  readonly #model: ModelPort | undefined;
  readonly #clock: ClockPort;
  readonly #config: AppConfig;
  readonly #states = new Map<string, RuntimeWindowState>();
  readonly #queues = new Map<string, Promise<RuntimeOutcome>>();
  readonly #persistQueues = new Map<string, Promise<void>>();
  readonly #serverCallTimes: number[] = [];
  #serverPersistQueue: Promise<void> = Promise.resolve();
  #serverRestored = false;
  #consecutiveFailures = 0;
  #circuitOpenUntil: number | undefined;
  // ADR 0002: an auth/credential failure pauses further *automatic*
  // attempts (server-wide, since the credential is shared) until an
  // explicit refresh runs or `secrets reload` clears it; ordinary quota and
  // circuit protections still apply on top of this.
  #authPausedReason: string | undefined;

  // D6: notified once per transition into (or a changed) display-profile
  // diagnostic, so the daemon can also write it to the diagnostic log.
  readonly #onDiagnostic: ((code: DisplayProfileDiagnostic) => void) | undefined;

  constructor(options: {
    tmux: TmuxPort;
    model?: ModelPort;
    clock?: ClockPort;
    config: AppConfig;
    onDiagnostic?: (code: DisplayProfileDiagnostic) => void;
  }) {
    this.#tmux = options.tmux;
    this.#model = options.model;
    this.#clock = options.clock ?? new RealClock();
    this.#config = options.config;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async handle(event: SemanticEvent): Promise<RuntimeOutcome> {
    let snapshot: TmuxWindowSnapshot;
    try {
      snapshot = await this.#tmux.snapshot({
        ...(event.windowId ? { windowId: event.windowId } : {}),
        ...(event.paneId ? { paneId: event.paneId } : {}),
      });
    } catch {
      return { kind: "ignored", windowId: event.windowId ?? "unknown", reason: "missing_window" };
    }

    const queued = this.#queues.get(snapshot.windowId);
    const previous = queued ?? Promise.resolve({
      kind: "ignored" as const,
      windowId: snapshot.windowId,
    });
    const next = previous
      .catch(() => ({ kind: "failed" as const, windowId: snapshot.windowId }))
      .then(async (): Promise<RuntimeOutcome> => {
        if (!queued) return this.#handleLocked(event, snapshot);
        try {
          const current = await this.#tmux.snapshot({ windowId: snapshot.windowId });
          return this.#handleLocked(event, current);
        } catch {
          return { kind: "ignored", windowId: snapshot.windowId, reason: "missing_window" };
        }
      });
    this.#queues.set(snapshot.windowId, next);
    void next.finally(() => {
      if (this.#queues.get(snapshot.windowId) === next) this.#queues.delete(snapshot.windowId);
    });
    return next;
  }

  async explain(target: TmuxTarget): Promise<ExplainReport> {
    const snapshot = await this.#tmux.snapshot(target);
    const state = await this.#stateFor(snapshot);
    this.#pruneCalls(state, this.#clock.now());
    const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
    const report: ExplainReport = {
      windowId: snapshot.windowId,
      mode: state.mode,
      revision: state.revision,
      accepted: state.accepted ?? false,
      visibleName: snapshot.windowName,
      badge: {
        state: state.badgeState,
        text: badgeText(state.badgeState, state.badgeStyle),
        style: state.badgeStyle,
      },
      limits: {
        windowCallsLastHour: state.callTimes.length,
        windowCallLimit: this.#config.limits.max_calls_per_window_hour,
        serverCallsLastHour: this.#serverCallTimes.length,
        serverCallLimit: this.#config.limits.max_calls_per_server_hour,
        ...(this.#circuitOpenUntil ? { circuitOpenUntil: this.#circuitOpenUntil } : {}),
      },
      ...(state.record ? { record: state.record } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(state.confidence !== undefined ? { confidence: state.confidence } : {}),
      ...(state.manualName ? { manualName: state.manualName } : {}),
      ...(state.fingerprint ? { fingerprint: state.fingerprint } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(active ? { liveActivity: normalizeActivity(active.command) } : {}),
      ...(state.displayDiagnostic ? { displayDiagnostic: state.displayDiagnostic } : {}),
    };
    return report;
  }

  clearCredential(): void {
    this.#model?.clearCredential();
  }

  async resetFailures(): Promise<void> {
    this.clearCredential();
    this.#consecutiveFailures = 0;
    this.#circuitOpenUntil = undefined;
    this.#authPausedReason = undefined;
    await this.#saveServer();
  }

  shutdown(): void {
    for (const state of this.#states.values()) {
      if (state.pendingTimer !== undefined) this.#clock.clearTimeout(state.pendingTimer);
      state.inFlight?.abort();
    }
    this.clearCredential();
  }

  async #handleLocked(
    event: SemanticEvent,
    snapshot: TmuxWindowSnapshot,
  ): Promise<RuntimeOutcome> {
    const state = await this.#stateFor(snapshot);
    await this.#primeSnapshotState(snapshot, state);

    if (event.kind === "manual_name_changed") {
      return this.#handleManual(event, snapshot, state);
    }
    if (event.kind === "new_work_requested") {
      return this.#handleNewWork(snapshot, state);
    }

    const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
    if (!active) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "no_panes" };
    }

    const candidates = buildScopeCandidates(snapshot);
    const { workspaceChanged, activity } = await this.#updateLocalRecord(
      snapshot,
      state,
      candidates,
      active,
    );

    if (state.mode === "manual") {
      await this.#setBadge(snapshot.windowId, state, "manual");
      return { kind: "manual", windowId: snapshot.windowId, name: state.manualName };
    }

    const { shouldInfer, forced } = this.#decideTrigger(event, state, workspaceChanged);
    if (!shouldInfer) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "no_trigger" };
    }

    return this.#scheduleOrRun(snapshot, state, candidates, event, activity, forced, active);
  }

  /** Syncs per-event display settings and clears a stale badge left over from before this runtime tracked the window. */
  async #primeSnapshotState(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
  ): Promise<void> {
    const resolved = resolveDisplayProfile(snapshot.displayProfile ?? this.#config.display.profile);
    state.lastProfile = resolved.profile;
    // D6: log a diagnostic only on a transition (new diagnostic, cleared
    // diagnostic, or a change to a different one), never on every event.
    if (resolved.diagnostic !== state.displayDiagnostic) {
      state.displayDiagnostic = resolved.diagnostic;
      if (resolved.diagnostic) this.#onDiagnostic?.(resolved.diagnostic);
    }
    state.badgeStyle = snapshot.badgeStyle ?? state.badgeStyle;
    if (!state.badgeSynced) {
      state.badgeSynced = true;
      await this.#setBadge(snapshot.windowId, state, state.badgeState);
    }
  }

  /**
   * Keeps the local (non-AI) Name Record's Scope in sync and its rendered
   * display current, applying or re-rendering it as needed. Returns
   * whether the local Workspace changed and the current (live) Activity,
   * both needed to decide whether an inference attempt is justified.
   * Activity itself is never stored in the Name Record (ADR 0003); it is
   * only threaded through as evidence for a possible model request.
   *
   * ADR 0001: once a Task is accepted, its Scope and Task are frozen --
   * automation may never replace them again, regardless of Workspace or
   * cwd changes. The record can still be re-rendered (e.g. a changed
   * display profile, or the one-time upgrade migration to the new default
   * format), just never reassigned.
   */
  async #updateLocalRecord(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
    candidates: ReturnType<typeof buildScopeCandidates>,
    active: TmuxPane,
  ): Promise<{ workspaceChanged: boolean; activity: string }> {
    const activity = normalizeActivity(active.command);

    if (state.accepted) {
      await this.#reapplyIfStale(snapshot, state);
      return { workspaceChanged: false, activity };
    }

    const localScope = deterministicScope(candidates);
    // ADR 0002: subdirectory changes within the same Workspace never
    // justify an inference attempt; only a Workspace-level change does.
    const workspaceChanged =
      state.lastLocalWorkspace !== undefined && state.lastLocalWorkspace !== localScope.workspace;
    state.lastLocalWorkspace = localScope.workspace;
    const firstRecord = state.record === undefined;

    if (firstRecord || workspaceChanged) {
      state.revision += 1;
      state.record = {
        scope: localScope,
        task: workspaceChanged ? "" : state.record?.task ?? "",
      };
      state.provenance = "fallback";
      if (state.mode === "automatic") await this.#applyRecord(snapshot, state);
      else await this.#save(snapshot.windowId, state);
    } else {
      await this.#reapplyIfStale(snapshot, state);
    }

    return { workspaceChanged, activity };
  }

  /**
   * Re-renders and applies the current record when its rendering no longer
   * matches what was last applied (a changed display profile, or -- for an
   * already-accepted record loaded from a pre-ADR-0003 persisted state --
   * the one-time migration to the new default format). A no-op once the
   * live tmux window name already matches.
   */
  async #reapplyIfStale(snapshot: TmuxWindowSnapshot, state: RuntimeWindowState): Promise<void> {
    if (!state.record || state.mode !== "automatic") return;
    const rendered = renderName(state.record, state.lastProfile);
    if (rendered && rendered !== state.lastAppliedName) {
      await this.#applyRecord(snapshot, state);
    }
  }

  /** Pure trigger decision: does this event justify an inference attempt, and is it forced (bypasses the minimum call interval)? */
  #decideTrigger(
    event: SemanticEvent,
    state: RuntimeWindowState,
    workspaceChanged: boolean,
  ): { shouldInfer: boolean; forced: boolean } {
    let shouldInfer = false;
    let forced = false;

    if (event.kind === "refresh_requested") {
      shouldInfer = true;
      forced = true;
    }

    // ADR 0001: automation may establish but never replace an accepted
    // Task, so only the explicit refresh handled above may reach the model.
    if (state.accepted) return { shouldInfer, forced };

    if (workspaceChanged) shouldInfer = true;
    if (event.kind === "content_settled") shouldInfer = true;
    if (event.kind === "command_finished" && isMeaningfulCommand(event.commandName)) {
      shouldInfer = true;
    }

    return { shouldInfer, forced };
  }

  /**
   * `tmux-autoname new` (New Work, ADR 0001): explicitly discards the
   * Window's Task, leaving a Workspace-only Provisional Name, and records
   * the current evidence fingerprint as a D1 baseline so residual on-screen
   * content from the discarded Task cannot by itself trigger a fresh
   * automatic attempt. Refuses in manual mode. Does not touch quotas.
   */
  async #handleNewWork(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
  ): Promise<RuntimeOutcome> {
    if (state.mode === "manual") {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "manual_mode" };
    }

    const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
    const candidates = buildScopeCandidates(snapshot);
    const localScope = deterministicScope(candidates);
    // ADR 0002 (D2/D4): unlike `refresh`, `new` is not listed as consent to
    // read a hidden pane's text, so the D1 baseline below must follow the
    // same visibility rule as every other automatic evidence read. Reading
    // it unconditionally here would also desync the baseline from later
    // automatic attempts, which recompute it with an empty terminal context
    // while the window stays hidden, defeating the D1 baseline entirely.
    const visible = active ? await this.#isWindowVisible(active.id) : false;
    const terminalContext =
      active && visible ? await this.#tmux.capturePane(active.id).catch(() => "") : "";

    state.revision += 1;
    state.inFlight?.abort();
    if (state.pendingTimer !== undefined) {
      this.#clock.clearTimeout(state.pendingTimer);
      state.pendingTimer = undefined;
    }
    state.accepted = false;
    state.provenance = "fallback";
    state.confidence = undefined;
    state.record = {
      scope: { workspace: localScope.workspace },
      task: "",
    };
    state.lastLocalWorkspace = localScope.workspace;
    state.fingerprint = evidenceFingerprint(snapshot, candidates, terminalContext);
    state.lastError = undefined;

    await this.#applyRecord(snapshot, state);
    await this.#setBadge(snapshot.windowId, state, "healthy");
    return { kind: "applied", windowId: snapshot.windowId, name: state.lastAppliedName };
  }

  /**
   * Applies dedup, model-availability, and rate-limit checks to a
   * justified trigger, then either runs inference immediately (forced) or
   * debounces it.
   */
  async #scheduleOrRun(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
    candidates: ReturnType<typeof buildScopeCandidates>,
    event: SemanticEvent,
    activity: string,
    forced: boolean,
    active: TmuxPane,
  ): Promise<RuntimeOutcome> {
    // ADR 0002 (D2/D4): automatic evidence is bounded to a pane that is
    // both selected and visible in an attached client. An explicit refresh
    // (forced) counts as consent to read that one pane even if hidden.
    const visible = forced || (await this.#isWindowVisible(active.id));
    const terminalContext = visible
      ? await this.#tmux.capturePane(active.id).catch(() => "")
      : "";
    const fingerprint = evidenceFingerprint(snapshot, candidates, terminalContext);
    if (!forced && fingerprint === state.fingerprint) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "deduplicated" };
    }

    if (!this.#model) {
      // ADR 0002: missing AI configuration is a normal outcome, not an
      // error badge; `explain` still surfaces the reason.
      state.lastError = "model_not_configured";
      await this.#save(snapshot.windowId, state);
      return { kind: "ignored", windowId: snapshot.windowId, reason: state.lastError };
    }

    const now = this.#clock.now();
    const blocked = this.#blockedReason(state, now, forced);
    if (blocked) {
      state.lastError = blocked;
      await this.#save(snapshot.windowId, state);
      return { kind: "ignored", windowId: snapshot.windowId, reason: blocked };
    }

    state.revision += 1;
    state.fingerprint = fingerprint;
    state.inFlight?.abort();
    if (state.pendingTimer !== undefined) this.#clock.clearTimeout(state.pendingTimer);
    await this.#setBadge(snapshot.windowId, state, "generating");

    const request = this.#request(
      snapshot,
      state,
      candidates,
      event,
      activity,
      terminalContext,
    );
    const revision = state.revision;
    if (forced) {
      await this.#save(snapshot.windowId, state);
      return this.#infer(snapshot.windowId, revision, fingerprint, request, true);
    }
    state.pendingTimer = this.#clock.setTimeout(() => {
      state.pendingTimer = undefined;
      void this.#infer(snapshot.windowId, revision, fingerprint, request, forced);
    }, this.#config.limits.debounce_ms);
    await this.#save(snapshot.windowId, state);
    return { kind: "scheduled", windowId: snapshot.windowId };
  }

  #request(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
    candidates: ReturnType<typeof buildScopeCandidates>,
    event: SemanticEvent,
    activity: string,
    terminalContext: string,
  ): NameRequest {
    const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0]!;
    return {
      serverId: snapshot.serverId,
      windowId: snapshot.windowId,
      revision: state.revision,
      fingerprint: state.fingerprint ?? "",
      structureFingerprint: evidenceFingerprint(snapshot, candidates, ""),
      ...(state.record ? { previous: state.record } : {}),
      ...(state.provenance ? { previousProvenance: state.provenance } : {}),
      activity,
      candidates,
      event,
      activePane: { cwd: active.cwd, command: active.command, title: active.title.slice(0, 200) },
      terminalContext,
      supportingPanes: snapshot.panes
        .filter((pane) => !pane.active)
        .slice(0, 4)
        .map(({ cwd, command, title }) => ({ cwd, command, title: title.slice(0, 200) })),
    };
  }

  async #infer(
    windowId: string,
    revision: number,
    fingerprint: string,
    request: NameRequest,
    forced: boolean,
  ): Promise<RuntimeOutcome> {
    const state = this.#states.get(windowId);
    if (!state) return { kind: "ignored", windowId, reason: "missing_window" };
    if (state.mode !== "automatic") {
      return { kind: "manual", windowId, name: state.manualName };
    }
    if (state.revision !== revision || state.fingerprint !== fingerprint) {
      return { kind: "ignored", windowId, reason: "superseded" };
    }
    if (!(await this.#currentSnapshot(request))) {
      return { kind: "ignored", windowId, reason: "evidence_changed" };
    }

    const now = this.#clock.now();
    // ADR 0002: forced (explicit refresh) attempts bypass the auth pause
    // below via #blockedReason's own `!forced` guard; the pause itself is
    // only lifted once a request actually succeeds (see the try block) or
    // via an explicit `secrets reload` (see resetFailures).
    const blocked = this.#blockedReason(state, now, forced);
    if (blocked) {
      state.lastError = blocked;
      await this.#setBadge(windowId, state, "healthy");
      return { kind: "ignored", windowId, reason: blocked };
    }

    state.callTimes.push(now);
    this.#serverCallTimes.push(now);
    state.lastCallAt = now;
    await Promise.all([this.#save(windowId, state), this.#saveServer()]);

    const controller = new AbortController();
    state.inFlight = controller;
    const timeout = this.#clock.setTimeout(
      () => controller.abort(new Error("model_timeout")),
      this.#config.limits.request_timeout_ms,
    );

    try {
      const proposal = await this.#model!.propose(request, controller.signal);
      const current = this.#states.get(windowId);
      const liveSnapshot = await this.#currentSnapshot(request);
      if (
        !current ||
        !liveSnapshot ||
        current.mode !== "automatic" ||
        current.revision !== revision ||
        current.fingerprint !== fingerprint
      ) {
        return { kind: "ignored", windowId, reason: "superseded" };
      }

      // ADR 0002 (D5): a proposal that came back at all -- accepted, kept,
      // or abstained -- is not an inference failure; it breaks the
      // consecutive-failure streak and lifts any auth pause.
      const resolution = resolveProposal(
        proposal,
        request,
        this.#config.ai?.confidence_threshold ?? 0.6,
      );
      current.lastError = undefined;
      this.#consecutiveFailures = 0;
      this.#circuitOpenUntil = undefined;
      this.#authPausedReason = undefined;
      await this.#saveServer();

      if (resolution.kind === "accepted") {
        current.record = resolution.record;
        current.provenance = "ai";
        current.accepted = true;
        current.confidence = resolution.confidence;
      } else if (resolution.kind === "kept") {
        // Only reachable when there was a previous Task to keep (refresh).
        current.accepted = true;
        current.provenance = "ai";
      }

      if (resolution.kind === "abstained") {
        await this.#save(windowId, current);
        await this.#setBadge(windowId, current, "healthy");
        return { kind: "ignored", windowId, reason: "abstained" };
      }

      await this.#applyRecord(liveSnapshot, current);
      if (current.lastError === "tmux_write_failed") {
        return { kind: "failed", windowId, reason: current.lastError };
      }
      await this.#setBadge(windowId, current, "healthy");
      return { kind: "applied", windowId, name: current.lastAppliedName };
    } catch (error) {
      const current = this.#states.get(windowId);
      if (!current || current.revision !== revision || current.mode !== "automatic") {
        return { kind: "ignored", windowId, reason: "superseded" };
      }
      if (controller.signal.aborted && current.fingerprint !== fingerprint) {
        return { kind: "ignored", windowId, reason: "superseded" };
      }

      const secretFailure =
        error instanceof SecretUnavailableError || error instanceof ProviderAuthenticationError;
      if (error instanceof ProviderAuthenticationError) this.#model?.clearCredential();
      current.lastError = safeErrorCode(error);
      // ADR 0002: an auth/credential failure pauses further automatic
      // attempts until an explicit refresh or `secrets reload`.
      if (secretFailure) this.#authPausedReason = current.lastError;
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= this.#config.limits.circuit_failure_threshold) {
        this.#circuitOpenUntil = this.#clock.now() + this.#config.limits.circuit_cooldown_ms;
      }
      await this.#saveServer();
      await this.#setBadge(
        windowId,
        current,
        secretFailure ? "secret_unavailable" : "failed",
      );
      return { kind: "failed", windowId, reason: current.lastError };
    } finally {
      this.#clock.clearTimeout(timeout);
      const current = this.#states.get(windowId);
      if (current?.inFlight === controller) current.inFlight = undefined;
    }
  }

  async #handleManual(
    event: SemanticEvent,
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
  ): Promise<RuntimeOutcome> {
    const requested = event.manualName ?? snapshot.windowName;
    if (requested === state.lastAppliedName || state.pluginNames.includes(requested)) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "plugin_rename" };
    }
    if (requested === "") {
      state.mode = "automatic";
      state.manualName = undefined;
      state.revision += 1;
      state.inFlight?.abort();
      if (state.pendingTimer !== undefined) this.#clock.clearTimeout(state.pendingTimer);
      if (state.record) await this.#applyRecord(snapshot, state);
      await this.#setBadge(snapshot.windowId, state, "healthy");
      return { kind: "applied", windowId: snapshot.windowId, name: state.lastAppliedName };
    }
    return this.#enterManual(snapshot, state, requested);
  }

  async #enterManual(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
    name: string,
  ): Promise<RuntimeOutcome> {
    state.mode = "manual";
    state.manualName = name;
    state.revision += 1;
    state.inFlight?.abort();
    if (state.pendingTimer !== undefined) this.#clock.clearTimeout(state.pendingTimer);
    await this.#setBadge(snapshot.windowId, state, "manual");
    return { kind: "manual", windowId: snapshot.windowId, name };
  }

  async #stateFor(snapshot: TmuxWindowSnapshot): Promise<RuntimeWindowState> {
    if (!this.#serverRestored) {
      this.#serverRestored = true;
      this.#serverCallTimes.push(...(snapshot.serverPersisted?.callTimes ?? []));
      this.#consecutiveFailures = snapshot.serverPersisted?.consecutiveFailures ?? 0;
      this.#circuitOpenUntil = snapshot.serverPersisted?.circuitOpenUntil;
    }
    const existing = this.#states.get(snapshot.windowId);
    if (existing) return existing;
    if (this.#states.size >= MAX_RUNTIME_WINDOWS) {
      const oldest = this.#states.entries().next().value as
        | [string, RuntimeWindowState]
        | undefined;
      if (oldest) {
        if (oldest[1].pendingTimer !== undefined) this.#clock.clearTimeout(oldest[1].pendingTimer);
        oldest[1].inFlight?.abort();
        this.#states.delete(oldest[0]);
        // Evicting an in-flight window must not leave a stale "generating" badge
        // displayed for a window this runtime no longer tracks.
        await this.#setBadge(
          oldest[0],
          oldest[1],
          oldest[1].mode === "manual" ? "manual" : "healthy",
        );
      }
    }
    const candidates = buildScopeCandidates(snapshot);
    const localScope = deterministicScope(candidates);
    const persisted = snapshot.persisted;
    const accepted = persisted?.accepted ?? false;
    // ADR 0001: an accepted Task's Workspace affiliation is fixed and
    // survives daemon restart even if it no longer looks "grounded" against
    // freshly computed candidates. Only a still-provisional (not yet
    // accepted) persisted Scope is re-validated and, if ungrounded,
    // discarded back to a fresh fallback on the next local-record update.
    const persistedRecord = persisted?.record;
    const ungrounded =
      !accepted && persistedRecord !== undefined && !isGroundedScope(persistedRecord.scope, candidates);
    const resolvedProfile = resolveDisplayProfile(
      snapshot.displayProfile ?? this.#config.display.profile,
    );
    const state: RuntimeWindowState = {
      version: CURRENT_PERSISTED_VERSION,
      mode: persisted?.mode ?? "automatic",
      revision: persisted?.revision ?? 0,
      ...(persisted?.record
        ? { record: { ...persisted.record, task: normalizeTask(persisted.record.task) } }
        : {}),
      ...(persisted?.provenance ? { provenance: persisted.provenance } : {}),
      accepted,
      ...(persisted?.confidence !== undefined ? { confidence: persisted.confidence } : {}),
      ...(persisted?.manualName ? { manualName: persisted.manualName } : {}),
      ...(persisted?.lastAppliedName ? { lastAppliedName: persisted.lastAppliedName } : {}),
      lastLocalWorkspace: ungrounded ? persistedRecord!.scope.workspace : localScope.workspace,
      lastProfile: resolvedProfile.profile,
      ...(resolvedProfile.diagnostic ? { displayDiagnostic: resolvedProfile.diagnostic } : {}),
      badgeStyle: snapshot.badgeStyle ?? "plain",
      badgeState: persisted?.mode === "manual" ? "manual" : "healthy",
      badgeSynced: false,
      pluginNames: persisted?.lastAppliedName ? [persisted.lastAppliedName] : [],
      callTimes: [...(persisted?.callTimes ?? [])],
      ...(persisted?.lastCallAt !== undefined ? { lastCallAt: persisted.lastCallAt } : {}),
    };
    this.#states.set(snapshot.windowId, state);
    // D6: a brand-new window state's initial diagnostic (if any) is itself
    // a transition into that diagnostic -- `#primeSnapshotState`'s
    // change-detection would otherwise never fire for it, since it
    // compares against this same value. Notify here so the very first
    // window observed with a bad template is logged, not just later ones.
    if (resolvedProfile.diagnostic) this.#onDiagnostic?.(resolvedProfile.diagnostic);
    return state;
  }

  #blockedReason(state: RuntimeWindowState, now: number, forced: boolean): string | undefined {
    this.#pruneCalls(state, now);
    if (this.#circuitOpenUntil !== undefined && now < this.#circuitOpenUntil) {
      return "circuit_open";
    }
    if (!forced && this.#authPausedReason !== undefined) {
      return this.#authPausedReason;
    }
    if (
      !forced &&
      state.lastCallAt !== undefined &&
      now - state.lastCallAt < this.#config.limits.minimum_call_interval_ms
    ) {
      return "minimum_interval";
    }
    if (state.callTimes.length >= this.#config.limits.max_calls_per_window_hour) {
      return "window_quota";
    }
    if (this.#serverCallTimes.length >= this.#config.limits.max_calls_per_server_hour) {
      return "server_quota";
    }
    return undefined;
  }

  #pruneCalls(state: RuntimeWindowState, now: number): void {
    while (state.callTimes[0] !== undefined && state.callTimes[0] <= now - HOUR_MS) {
      state.callTimes.shift();
    }
    while (
      this.#serverCallTimes[0] !== undefined &&
      this.#serverCallTimes[0] <= now - HOUR_MS
    ) {
      this.#serverCallTimes.shift();
    }
    if (this.#circuitOpenUntil !== undefined && now >= this.#circuitOpenUntil) {
      this.#circuitOpenUntil = undefined;
      this.#consecutiveFailures = 0;
    }
  }

  async #applyRecord(
    snapshot: TmuxWindowSnapshot,
    state: RuntimeWindowState,
  ): Promise<void> {
    if (!state.record || state.mode !== "automatic") return;
    const name = renderName(state.record, state.lastProfile);
    if (!name) return;
    state.lastAppliedName = name;
    if (!state.pluginNames.includes(name)) {
      state.pluginNames.push(name);
      if (state.pluginNames.length > 4) state.pluginNames.shift();
    }
    await this.#save(snapshot.windowId, state);
    if (snapshot.windowName === name) return;
    try {
      await this.#tmux.rename(snapshot.windowId, name);
      state.lastError = undefined;
    } catch {
      state.lastError = "tmux_write_failed";
      await this.#setBadge(snapshot.windowId, state, "failed");
    }
  }

  async #setBadge(
    windowId: string,
    state: RuntimeWindowState,
    badgeState: BadgeState,
  ): Promise<void> {
    state.badgeState = badgeState;
    try {
      await this.#tmux.setBadge(windowId, badgeText(badgeState, state.badgeStyle));
    } catch {
      state.lastError ??= "tmux_badge_failed";
    }
    await this.#save(windowId, state);
  }

  async #save(windowId: string, state: RuntimeWindowState): Promise<void> {
    const persisted: PersistedWindowState = {
      version: CURRENT_PERSISTED_VERSION,
      mode: state.mode,
      revision: state.revision,
      ...(state.record ? { record: state.record } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(state.accepted ? { accepted: state.accepted } : {}),
      ...(state.confidence !== undefined ? { confidence: state.confidence } : {}),
      ...(state.manualName ? { manualName: state.manualName } : {}),
      ...(state.lastAppliedName ? { lastAppliedName: state.lastAppliedName } : {}),
      ...(state.callTimes.length > 0 ? { callTimes: state.callTimes } : {}),
      ...(state.lastCallAt !== undefined ? { lastCallAt: state.lastCallAt } : {}),
    };
    const previous = this.#persistQueues.get(windowId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#tmux.persist(windowId, persisted))
      .catch(() => {
        state.lastError ??= "tmux_state_failed";
      });
    this.#persistQueues.set(windowId, next);
    await next;
    if (this.#persistQueues.get(windowId) === next) this.#persistQueues.delete(windowId);
  }

  async #saveServer(): Promise<void> {
    const persisted: PersistedServerState = {
      callTimes: [...this.#serverCallTimes],
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#circuitOpenUntil !== undefined
        ? { circuitOpenUntil: this.#circuitOpenUntil }
        : {}),
    };
    const next = this.#serverPersistQueue
      .catch(() => undefined)
      .then(() => this.#tmux.persistServer(persisted))
      .catch(() => undefined);
    this.#serverPersistQueue = next;
    await next;
  }

  async #currentSnapshot(request: NameRequest): Promise<TmuxWindowSnapshot | undefined> {
    try {
      const snapshot = await this.#tmux.snapshot({ windowId: request.windowId });
      if (snapshot.serverId !== request.serverId || snapshot.windowId !== request.windowId) {
        return undefined;
      }
      const fingerprint = evidenceFingerprint(snapshot, buildScopeCandidates(snapshot), "");
      return fingerprint === request.structureFingerprint ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * ADR 0002 (D2): a Window's active pane text is only in-bounds while that
   * Window is the current window of at least one attached client, i.e. its
   * active pane is one of the clients' current active panes.
   */
  async #isWindowVisible(activePaneId: string): Promise<boolean> {
    try {
      const active = await this.#tmux.activePanes();
      return active.includes(activePaneId);
    } catch {
      return false;
    }
  }
}

const safeErrorCode = (error: unknown): string => {
  if (error instanceof SecretUnavailableError) return "secret_unavailable";
  if (error instanceof ProviderAuthenticationError) return "provider_authentication_failed";
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.message === "model_timeout") return "model_timeout";
    if (error.message === "invalid_model_response") return error.message;
  }
  return "model_failed";
};
