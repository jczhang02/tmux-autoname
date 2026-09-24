import {
  type BadgeStyle,
  type NameProposal,
  type NameRequest,
  type PersistedWindowState,
  type PersistedServerState,
  type TmuxWindowSnapshot,
} from "../src/domain";
import type { ClockPort, ModelPort, TmuxPort, TmuxTarget } from "../src/runtime";

export class FakeClock implements ClockPort {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].callback();
      await flush();
    }
    this.#now = target;
    await flush();
  }

  get timerCount(): number {
    return this.#timers.size;
  }
}

export class FakeTmux implements TmuxPort {
  readonly snapshots = new Map<string, TmuxWindowSnapshot>();
  readonly contents = new Map<string, string>();
  readonly renames: Array<{ windowId: string; name: string }> = [];
  readonly badges: Array<{ windowId: string; badge: string }> = [];
  readonly hiddenPanes = new Set<string>();
  serverState: PersistedServerState | undefined;

  add(snapshot: TmuxWindowSnapshot): void {
    this.serverState ??= snapshot.serverPersisted;
    this.snapshots.set(snapshot.windowId, structuredClone(snapshot));
    for (const pane of snapshot.panes) {
      this.contents.set(pane.id, "redesign the tmux window naming plugin");
    }
  }

  get(windowId: string): TmuxWindowSnapshot {
    const snapshot = this.snapshots.get(windowId);
    if (!snapshot) throw new Error("missing fake window");
    return snapshot;
  }

  async snapshot(target: TmuxTarget): Promise<TmuxWindowSnapshot> {
    if (target.windowId) {
      const snapshot = structuredClone(this.get(target.windowId));
      snapshot.serverPersisted = structuredClone(this.serverState);
      return snapshot;
    }
    const snapshot = [...this.snapshots.values()].find((candidate) =>
      candidate.panes.some((pane) => pane.id === target.paneId),
    );
    if (!snapshot) throw new Error("missing fake target");
    const result = structuredClone(snapshot);
    result.serverPersisted = structuredClone(this.serverState);
    return result;
  }

  async activePanes(): Promise<string[]> {
    return [...this.snapshots.values()]
      .flatMap((snapshot) => snapshot.panes)
      .filter((pane) => pane.active && !this.hiddenPanes.has(pane.id))
      .map((pane) => pane.id);
  }

  /** Marks a window's active pane as not the current window of any attached client (D2/D4). */
  hide(paneId: string): void {
    this.hiddenPanes.add(paneId);
  }

  async capturePane(paneId: string): Promise<string> {
    return this.contents.get(paneId) ?? "";
  }

  async rename(windowId: string, name: string): Promise<void> {
    this.get(windowId).windowName = name;
    this.renames.push({ windowId, name });
  }

  async persist(windowId: string, state: PersistedWindowState): Promise<void> {
    this.get(windowId).persisted = structuredClone(state);
  }

  async persistServer(state: PersistedServerState): Promise<void> {
    this.serverState = structuredClone(state);
  }

  async setBadge(windowId: string, badge: string): Promise<void> {
    this.badges.push({ windowId, badge });
  }

  setPath(windowId: string, cwd: string, gitRoot?: string): void {
    const active = this.get(windowId).panes.find((pane) => pane.active);
    if (!active) throw new Error("missing active pane");
    active.cwd = cwd;
    active.gitRoot = gitRoot;
  }

  setActivity(windowId: string, activity: string): void {
    const active = this.get(windowId).panes.find((pane) => pane.active);
    if (!active) throw new Error("missing active pane");
    active.command = activity;
  }

  setContent(paneId: string, content: string): void {
    this.contents.set(paneId, content);
  }

  setProfile(windowId: string, profile: string): void {
    this.get(windowId).displayProfile = profile;
  }

  setBadgeStyle(windowId: string, style: BadgeStyle): void {
    this.get(windowId).badgeStyle = style;
  }
}

export class FakeModel implements ModelPort {
  readonly calls: NameRequest[] = [];
  clearCount = 0;
  handler: (request: NameRequest, signal: AbortSignal) => Promise<NameProposal>;

  constructor(
    handler: (request: NameRequest, signal: AbortSignal) => Promise<NameProposal> = async (
      request,
    ) => proposalFor(request),
  ) {
    this.handler = handler;
  }

  async propose(request: NameRequest, signal: AbortSignal): Promise<NameProposal> {
    this.calls.push(structuredClone(request));
    return this.handler(request, signal);
  }

  clearCredential(): void {
    this.clearCount += 1;
  }
}

export const proposalFor = (
  request: NameRequest,
  task = "redesign naming plugin",
): NameProposal => ({
  outcome: "propose",
  workspaceId: request.candidates[0]!.id,
  task,
  confidence: 0.95,
});

export const keepProposal = (): NameProposal => ({ outcome: "keep" });

export const abstainProposal = (): NameProposal => ({ outcome: "abstain" });

export const windowSnapshot = (overrides: Partial<TmuxWindowSnapshot> = {}): TmuxWindowSnapshot => ({
  serverId: "server-1",
  windowId: "@1",
  windowName: "shell",
  sessionName: "partjobs",
  sessionPath: "/home/jc/dev/partjobs",
  panes: [
    {
      id: "%1",
      active: true,
      cwd: "/home/jc/dev/partjobs/high-value-patent-rebuild/manuscript",
      command: "codex",
      pid: 100,
      title: "codex",
      gitRoot: "/home/jc/dev/partjobs/high-value-patent-rebuild",
    },
  ],
  badgeStyle: "plain",
  ...overrides,
});

export const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Bun.sleep(0);
  await Promise.resolve();
};

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
