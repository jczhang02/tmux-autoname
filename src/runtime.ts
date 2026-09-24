import type { AppConfig } from "./config";
import {
  acceptProposal,
  badgeText,
  buildScopeCandidates,
  deterministicScope,
  evidenceFingerprint,
  isGroundedScope,
  isMeaningfulCommand,
  normalizeActivity,
  normalizeTask,
  renderName,
  scopeKey,
  type BadgeState,
  type BadgeStyle,
  type NameProposal,
  type NameRecord,
  type NameRequest,
  type PersistedServerState,
  type PersistedWindowState,
  type SemanticEvent,
  type TmuxWindowSnapshot,
} from "./domain";

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
  lastLocalScope?: string;
  lastProfile: string;
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
  manualName?: string;
  visibleName: string;
  badge: { state: BadgeState; text: string; style: BadgeStyle };
  fingerprint?: string;
  lastError?: string;
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

  constructor(options: {
    tmux: TmuxPort;
    model?: ModelPort;
    clock?: ClockPort;
    config: AppConfig;
  }) {
    this.#tmux = options.tmux;
    this.#model = options.model;
    this.#clock = options.clock ?? new RealClock();
    this.#config = options.config;
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
    const report: ExplainReport = {
      windowId: snapshot.windowId,
      mode: state.mode,
      revision: state.revision,
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
      ...(state.manualName ? { manualName: state.manualName } : {}),
      ...(state.fingerprint ? { fingerprint: state.fingerprint } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
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
    state.lastProfile = snapshot.displayProfile ?? this.#config.display.profile;
    state.badgeStyle = snapshot.badgeStyle ?? state.badgeStyle;
    if (!state.badgeSynced) {
      state.badgeSynced = true;
      await this.#setBadge(snapshot.windowId, state, state.badgeState);
    }

    if (event.kind === "manual_name_changed") {
      return this.#handleManual(event, snapshot, state);
    }

    const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
    if (!active) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "no_panes" };
    }

    const candidates = buildScopeCandidates(snapshot);
    const localScope = deterministicScope(candidates);
    const localScopeKey = scopeKey(localScope);
    const scopeChanged =
      state.lastLocalScope !== undefined && state.lastLocalScope !== localScopeKey;
    state.lastLocalScope = localScopeKey;
    const activity = normalizeActivity(active.command);
    const activityChanged = state.record?.activity !== activity;
    const firstRecord = state.record === undefined;

    if (firstRecord || scopeChanged || activityChanged) {
      state.revision += 1;
      state.record = {
        scope: firstRecord || scopeChanged ? localScope : state.record?.scope ?? localScope,
        task: scopeChanged ? "" : state.record?.task ?? "",
        activity,
      };
      if (firstRecord || scopeChanged) state.provenance = "fallback";
      if (state.mode === "automatic") await this.#applyRecord(snapshot, state);
      else await this.#save(snapshot.windowId, state);
    } else {
      const rendered = state.record ? renderName(state.record, state.lastProfile) : "";
      if (rendered && rendered !== state.lastAppliedName && state.mode === "automatic") {
        await this.#applyRecord(snapshot, state);
      }
    }

    if (state.mode === "manual") {
      await this.#setBadge(snapshot.windowId, state, "manual");
      return { kind: "manual", windowId: snapshot.windowId, name: state.manualName };
    }

    let shouldInfer = false;
    let forced = false;

    if (event.kind === "refresh_requested") {
      shouldInfer = true;
      forced = true;
    }

    if (scopeChanged) shouldInfer = true;
    if (event.kind === "content_settled") shouldInfer = true;

    if (
      event.kind === "command_finished" &&
      state.provenance !== "ai" &&
      isMeaningfulCommand(event.commandName)
    ) {
      shouldInfer = true;
    }

    if (!shouldInfer) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "no_trigger" };
    }

    const terminalContext = await this.#tmux.capturePane(active.id).catch(() => "");
    const fingerprint = evidenceFingerprint(snapshot, candidates, terminalContext);
    if (!forced && fingerprint === state.fingerprint) {
      return { kind: "ignored", windowId: snapshot.windowId, reason: "deduplicated" };
    }

    if (!this.#model) {
      state.lastError = "model_not_configured";
      await this.#setBadge(snapshot.windowId, state, "failed");
      return { kind: "failed", windowId: snapshot.windowId, reason: state.lastError };
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
    const blocked = this.#blockedReason(state, now, forced);
    if (blocked) {
      state.lastError = blocked;
      await this.#setBadge(windowId, state, "failed");
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

      const record = acceptProposal(
        proposal,
        request,
        this.#config.ai?.confidence_threshold ?? 0.6,
      );
      if (!record) throw new Error("invalid_model_proposal");

      current.record = record;
      current.provenance = "ai";
      current.lastError = undefined;
      this.#consecutiveFailures = 0;
      this.#circuitOpenUntil = undefined;
      await this.#saveServer();
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
    const state: RuntimeWindowState = {
      mode: persisted?.mode ?? "automatic",
      revision: persisted?.revision ?? 0,
      ...(persisted?.record
        ? { record: { ...persisted.record, task: normalizeTask(persisted.record.task) } }
        : {}),
      ...(persisted?.provenance ? { provenance: persisted.provenance } : {}),
      ...(persisted?.manualName ? { manualName: persisted.manualName } : {}),
      ...(persisted?.lastAppliedName ? { lastAppliedName: persisted.lastAppliedName } : {}),
      lastLocalScope: scopeKey(
        persisted?.record && !isGroundedScope(persisted.record.scope, candidates)
          ? persisted.record.scope
          : localScope,
      ),
      lastProfile: snapshot.displayProfile ?? this.#config.display.profile,
      badgeStyle: snapshot.badgeStyle ?? "plain",
      badgeState: persisted?.mode === "manual" ? "manual" : "healthy",
      badgeSynced: false,
      pluginNames: persisted?.lastAppliedName ? [persisted.lastAppliedName] : [],
      callTimes: [...(persisted?.callTimes ?? [])],
      ...(persisted?.lastCallAt !== undefined ? { lastCallAt: persisted.lastCallAt } : {}),
    };
    this.#states.set(snapshot.windowId, state);
    return state;
  }

  #blockedReason(state: RuntimeWindowState, now: number, forced: boolean): string | undefined {
    this.#pruneCalls(state, now);
    if (this.#circuitOpenUntil !== undefined && now < this.#circuitOpenUntil) {
      return "circuit_open";
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
      mode: state.mode,
      revision: state.revision,
      ...(state.record ? { record: state.record } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
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
}

const safeErrorCode = (error: unknown): string => {
  if (error instanceof SecretUnavailableError) return "secret_unavailable";
  if (error instanceof ProviderAuthenticationError) return "provider_authentication_failed";
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.message === "model_timeout") return "model_timeout";
    if (["invalid_model_proposal", "invalid_model_response"].includes(error.message)) {
      return error.message;
    }
  }
  return "model_failed";
};
