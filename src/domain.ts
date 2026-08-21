import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const eventKinds = [
  "command_started",
  "command_finished",
  "content_settled",
  "window_changed",
  "manual_name_changed",
  "refresh_requested",
] as const;

export const semanticEventSchema = z
  .object({
    version: z.literal(1).default(1),
    source: z.enum(["tmux", "zsh", "cli", "test"]),
    kind: z.enum(eventKinds),
    windowId: z.string().regex(/^@\d+$/).optional(),
    paneId: z.string().regex(/^%\d+$/).optional(),
    commandName: z.string().max(128).optional(),
    exitCode: z.number().int().optional(),
    manualName: z.string().max(512).optional(),
    timestamp: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((event) => event.windowId !== undefined || event.paneId !== undefined, {
    message: "windowId or paneId is required",
  });

export type SemanticEvent = z.infer<typeof semanticEventSchema>;

export type Scope = {
  workspace: string;
  area?: string;
};

export type NameRecord = {
  scope: Scope;
  task: string;
  activity: string;
};

export type TmuxPane = {
  id: string;
  active: boolean;
  cwd: string;
  command: string;
  pid: number;
  title: string;
  gitRoot?: string;
  remoteHost?: string;
};

export type PersistedWindowState = {
  mode: "automatic" | "manual";
  revision: number;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  manualName?: string;
  lastAppliedName?: string;
  callTimes?: number[];
  lastCallAt?: number;
};

export type PersistedServerState = {
  callTimes: number[];
  consecutiveFailures: number;
  circuitOpenUntil?: number;
};

export const persistedWindowStateSchema: z.ZodType<PersistedWindowState> = z.object({
  mode: z.enum(["automatic", "manual"]),
  revision: z.number().int().nonnegative(),
  record: z
    .object({
      scope: z.object({ workspace: z.string(), area: z.string().optional() }),
      task: z.string(),
      activity: z.string(),
    })
    .optional(),
  provenance: z.enum(["fallback", "ai"]).optional(),
  manualName: z.string().optional(),
  lastAppliedName: z.string().optional(),
  callTimes: z.array(z.number().int().nonnegative()).max(1000).optional(),
  lastCallAt: z.number().int().nonnegative().optional(),
});

export const persistedServerStateSchema: z.ZodType<PersistedServerState> = z.object({
  callTimes: z.array(z.number().int().nonnegative()).max(1000),
  consecutiveFailures: z.number().int().nonnegative(),
  circuitOpenUntil: z.number().int().nonnegative().optional(),
});

export type TmuxWindowSnapshot = {
  serverId: string;
  windowId: string;
  windowName: string;
  sessionName: string;
  sessionPath: string;
  panes: TmuxPane[];
  sessionCwds?: string[];
  persisted?: PersistedWindowState;
  serverPersisted?: PersistedServerState;
  displayProfile?: string;
  badgeStyle?: BadgeStyle;
};

export type ScopeCandidate = {
  id: string;
  value: string;
  kind: "workspace" | "area";
  workspaceId?: string;
  root?: string;
  facts: string[];
};

export type ScopeCandidates = {
  workspaces: ScopeCandidate[];
  areas: ScopeCandidate[];
};

export const nameProposalSchema = z.object({
  workspaceId: z.string(),
  areaId: z.string().nullable(),
  task: z.string(),
  taskDecision: z.enum(["keep", "replace"]),
  confidence: z.number().min(0).max(1),
});

export type NameProposal = z.infer<typeof nameProposalSchema>;

export type NameRequest = {
  serverId: string;
  windowId: string;
  revision: number;
  fingerprint: string;
  structureFingerprint: string;
  previous?: NameRecord;
  previousProvenance?: "fallback" | "ai";
  activity: string;
  candidates: ScopeCandidates;
  event: SemanticEvent;
  activePane: Pick<TmuxPane, "cwd" | "command" | "title">;
  terminalContext: string;
  supportingPanes: Array<Pick<TmuxPane, "cwd" | "command" | "title">>;
};

export type BadgeState =
  | "healthy"
  | "generating"
  | "failed"
  | "secret_unavailable"
  | "manual";

export type BadgeStyle = "plain" | "nerd";

export const badgeText = (state: BadgeState, style: BadgeStyle): string => {
  const badges: Record<BadgeStyle, Record<BadgeState, string>> = {
    plain: {
      healthy: "",
      generating: "…",
      failed: "!",
      secret_unavailable: "K!",
      manual: "M",
    },
    nerd: {
      healthy: "",
      generating: "󰚩",
      failed: "",
      secret_unavailable: "",
      manual: "",
    },
  };
  return badges[style][state];
};

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

const uniqueBy = <T>(values: T[], key: (value: T) => string): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
};

const cleanPath = (value: string): string => {
  if (!value) return "";
  return resolve(value);
};

const basename = (value: string): string => {
  const parts = cleanPath(value).split(sep).filter(Boolean);
  return parts.at(-1) ?? "shell";
};

const relativeArea = (root: string, cwd: string): string | undefined => {
  if (!root || !cwd || !isAbsolute(root) || !isAbsolute(cwd)) return undefined;
  const value = relative(cleanPath(root), cleanPath(cwd));
  if (!value || value === "." || value.startsWith(`..${sep}`) || value === "..") {
    return undefined;
  }
  return value.split(sep).join("/");
};

const commonAncestor = (paths: string[]): string | undefined => {
  const absolute = uniqueBy(paths.filter(isAbsolute).map(cleanPath), (value) => value);
  if (absolute.length < 2) return undefined;
  const parts = absolute.map((value) => value.split(sep).filter(Boolean));
  const shared: string[] = [];
  for (let index = 0; ; index += 1) {
    const value = parts[0]?.[index];
    if (!value || parts.some((candidate) => candidate[index] !== value)) break;
    shared.push(value);
  }
  return shared.length >= 2 ? `${sep}${shared.join(sep)}` : undefined;
};

export const buildScopeCandidates = (
  snapshot: TmuxWindowSnapshot,
): ScopeCandidates => {
  const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
  if (!active) {
    const workspace = snapshot.sessionName || "shell";
    return {
      workspaces: [
        {
          id: `workspace:${stableHash(workspace)}`,
          value: workspace,
          kind: "workspace",
          facts: ["tmux session context"],
        },
      ],
      areas: [],
    };
  }

  type WorkspaceRoot = { value: string; root: string | undefined; facts: string[] };
  const roots: WorkspaceRoot[] = [];
  const sessionRoot = snapshot.sessionPath ? cleanPath(snapshot.sessionPath) : undefined;
  const sessionOwnsActive = Boolean(
    sessionRoot &&
      snapshot.sessionName &&
      basename(sessionRoot) === snapshot.sessionName &&
      (sessionRoot === cleanPath(active.cwd) || relativeArea(sessionRoot, active.cwd)),
  );
  if (active.remoteHost) {
    roots.push({
      value: active.remoteHost,
      root: undefined,
      facts: ["remote host identity"],
    });
  }
  if (sessionOwnsActive && sessionRoot) {
    roots.push({
      value: snapshot.sessionName,
      root: sessionRoot,
      facts: ["tmux session workspace", "session path contains active pane"],
    });
  }
  if (active.gitRoot) {
    roots.push({
      value: basename(active.gitRoot),
      root: cleanPath(active.gitRoot),
      facts: ["active pane git root"],
    });
  }
  roots.push(
    {
      value: snapshot.sessionName || basename(active.cwd),
      root: sessionOwnsActive ? sessionRoot : undefined,
      facts: ["tmux session context"],
    },
    {
      value: basename(active.cwd),
      root: cleanPath(active.cwd),
      facts: ["active pane cwd"],
    },
  );
  for (const pane of snapshot.panes.filter((pane) => pane.id !== active.id)) {
    if (pane.gitRoot) {
      roots.push({
        value: basename(pane.gitRoot),
        root: cleanPath(pane.gitRoot),
        facts: ["supporting pane git root"],
      });
    }
    if (pane.cwd) {
      roots.push({
        value: basename(pane.cwd),
        root: cleanPath(pane.cwd),
        facts: ["supporting pane cwd"],
      });
    }
  }
  const allCwds = [
    ...snapshot.panes.map((pane) => pane.cwd),
    ...(snapshot.sessionCwds ?? []),
  ];
  const ancestor = commonAncestor(allCwds);
  if (ancestor) {
    roots.push({
      value: basename(ancestor),
      root: ancestor,
      facts: ["stable common ancestor across session panes"],
    });
  }
  const workspaceRoots = uniqueBy(
    roots.filter((candidate) => candidate.value.length > 0),
    (candidate) => candidate.value,
  );

  const workspaces = workspaceRoots.map((candidate) => ({
    id: `workspace:${stableHash(candidate)}`,
    value: candidate.value,
    kind: "workspace" as const,
    ...(candidate.root ? { root: candidate.root } : {}),
    facts: candidate.facts,
  }));

  const areaCandidates: ScopeCandidate[] = [];
  for (const [index, candidate] of workspaceRoots.entries()) {
    const value = candidate.root ? relativeArea(candidate.root, active.cwd) : undefined;
    if (!value) continue;
    areaCandidates.push({
      id: `area:${stableHash({ root: candidate.root, value })}`,
      value,
      kind: "area",
      workspaceId: workspaces[index]!.id,
      root: candidate.root,
      facts: [`active cwd relative to ${candidate.value}`],
    });
  }
  const areas = [...areaCandidates.reduce((merged, candidate) => {
    const key = `${candidate.workspaceId ?? ""}\0${candidate.value}`;
    const existing = merged.get(key);
    if (existing) {
      existing.facts = [...new Set([...existing.facts, ...candidate.facts])];
    } else {
      merged.set(key, candidate);
    }
    return merged;
  }, new Map<string, ScopeCandidate>()).values()];

  return { workspaces, areas };
};

export const deterministicScope = (candidates: ScopeCandidates): Scope => {
  const workspace = candidates.workspaces[0];
  if (!workspace) return { workspace: "shell" };
  const area = candidates.areas.find((candidate) => candidate.workspaceId === workspace.id);
  return area
    ? { workspace: workspace.value, area: area.value }
    : { workspace: workspace.value };
};

export const isGroundedScope = (scope: Scope, candidates: ScopeCandidates): boolean => {
  const workspaces = candidates.workspaces.filter(
    (candidate) => candidate.value === scope.workspace,
  );
  if (workspaces.length === 0) return false;
  if (!scope.area) return true;
  return workspaces.some((workspace) =>
    candidates.areas.some(
      (area) => area.workspaceId === workspace.id && area.value === scope.area,
    )
  );
};

export const normalizeActivity = (command: string): string => {
  const value = command.trim().split("/").at(-1)?.toLowerCase() ?? "shell";
  const aliases: Record<string, string> = {
    node: "node",
    bun: "bun",
    nvim: "nvim",
    vim: "vim",
    zsh: "zsh",
    bash: "bash",
    fish: "fish",
  };
  const normalized = value.replace(/-coding-agent$/u, "");
  return aliases[normalized] ?? (normalized.replace(/[^a-z0-9._+-]/g, "") || "shell");
};

export const renderName = (
  record: NameRecord,
  profile = "{activity}:{scope}/{task}",
): string => {
  const scope = record.scope.area
    ? `${record.scope.workspace}/${record.scope.area}`
    : record.scope.workspace;
  const values: Record<string, string> = {
    activity: record.activity,
    scope,
    task: record.task,
  };
  const rendered = profile.replace(
    /\{(activity|scope|task)\}/g,
    (_match, key: keyof typeof values) => values[key] ?? "",
  );
  return rendered
    .replace(/:+/g, ":")
    .replace(/\/{2,}/g, "/")
    .replace(/:\//g, ":")
    .replace(/^[:/]+|[:/]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export const isValidTask = (task: string): boolean => {
  if (/[\u0000-\u001f\u007f\u001b]/u.test(task)) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?: [a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/.test(task)) {
    return false;
  }
  return !/^(?:i cannot|i can't|sorry|here is|the task|unable to)\b/.test(task);
};

export const acceptProposal = (
  proposal: NameProposal,
  request: NameRequest,
  confidenceThreshold: number,
): NameRecord | undefined => {
  if (proposal.confidence < confidenceThreshold) return undefined;
  const workspace = request.candidates.workspaces.find(
    (candidate) => candidate.id === proposal.workspaceId,
  );
  const area = proposal.areaId
    ? request.candidates.areas.find((candidate) => candidate.id === proposal.areaId)
    : undefined;
  if (
    !workspace ||
    (proposal.areaId !== null && (!area || area.workspaceId !== workspace.id))
  ) return undefined;

  const task = proposal.taskDecision === "keep" ? request.previous?.task : proposal.task;
  if (!task || !isValidTask(task)) return undefined;

  return {
    scope: area
      ? { workspace: workspace.value, area: area.value }
      : { workspace: workspace.value },
    task,
    activity: request.activity,
  };
};

export const evidenceFingerprint = (
  snapshot: TmuxWindowSnapshot,
  candidates: ScopeCandidates,
  terminalContext: string,
): string => {
  const active = snapshot.panes.find((pane) => pane.active) ?? snapshot.panes[0];
  return stableHash({
    windowId: snapshot.windowId,
    sessionName: snapshot.sessionName,
    sessionPath: snapshot.sessionPath,
    active: active
      ? { id: active.id, cwd: active.cwd, command: active.command, gitRoot: active.gitRoot }
      : undefined,
    candidates,
    terminalContext: stableTerminalEvidence(terminalContext),
  });
};

const stableTerminalEvidence = (value: string): string[] => [
  ...new Set(
    value.split("\n")
      .map((line) => line
        .replace(/^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/gu, "")
        .replace(/[%$#>]\s*$/u, "")
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase())
      .filter((line) => line.length >= 4)
      .filter((line) => !/^(?:~|\/|\.\.?\/)\S*(?:\s+.*\d){2}/u.test(line)),
  ),
].slice(-24);

export const scopeKey = (scope: Scope): string => `${scope.workspace}\0${scope.area ?? ""}`;

export const isMeaningfulCommand = (commandName: string | undefined): boolean => {
  if (!commandName) return false;
  return !new Set(["cd", "ls", "pwd", "clear", "exit", "true", "echo"]).has(
    commandName.toLowerCase(),
  );
};
