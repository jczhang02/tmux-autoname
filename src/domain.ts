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
  "new_work_requested",
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

// ADR 0003: Scope is a Workspace only. Area (a cwd-derived subdirectory of
// the Workspace) is no longer part of Scope or the Name Record.
export type Scope = {
  workspace: string;
};

// ADR 0003: Activity is live information observed separately (see
// `normalizeActivity` and `ExplainReport.liveActivity`), never part of the
// durable Name Record.
export type NameRecord = {
  scope: Scope;
  task: string;
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

const CURRENT_PERSISTED_VERSION = 2;

export type PersistedWindowState = {
  version: typeof CURRENT_PERSISTED_VERSION;
  mode: "automatic" | "manual";
  revision: number;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  // ADR 0001: once true, the Task is accepted and automation may never
  // replace it again; only an explicit `refresh` or `new` may. Absent (or
  // false) means the record, if any, is still a provisional guess.
  accepted?: boolean;
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
  version: z.literal(CURRENT_PERSISTED_VERSION),
  mode: z.enum(["automatic", "manual"]),
  revision: z.number().int().nonnegative(),
  record: z
    .object({
      scope: z.object({ workspace: z.string() }),
      task: z.string(),
    })
    .optional(),
  provenance: z.enum(["fallback", "ai"]).optional(),
  accepted: z.boolean().optional(),
  manualName: z.string().optional(),
  lastAppliedName: z.string().optional(),
  callTimes: z.array(z.number().int().nonnegative()).max(1000).optional(),
  lastCallAt: z.number().int().nonnegative().optional(),
});

// Pre-ADR-0003 persisted shape: unversioned, Scope carried an optional Area
// and NameRecord carried Activity. Kept only to drive the one-time upgrade
// migration in `decodePersistedWindowState` below.
const legacyPersistedWindowStateSchema = z.object({
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
  accepted: z.boolean().optional(),
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

/**
 * Upgrade migration (ADR 0003). Decodes a persisted Window state written by
 * either the current (versioned) schema or the pre-ADR-0003 legacy shape.
 *
 * A legacy record with a valid Task and AI provenance becomes accepted
 * without a new AI request; its Workspace is retained, and Activity/Area
 * are dropped since they no longer exist. Manual Names pass through
 * untouched. A legacy Task that is not valid, even after the usual
 * deterministic repair, is corrupt or of uncertain ownership: rather than
 * guess at it, it is dropped, leaving the window to start fresh with a
 * Workspace-only Provisional Name on the next automatic update -- it is
 * never used to overwrite whatever name is currently visible. Completely
 * unparseable state decodes to `undefined`, identical to no persisted state
 * at all, for the same reason.
 */
export const decodePersistedWindowState = (raw: unknown): PersistedWindowState | undefined => {
  const current = persistedWindowStateSchema.safeParse(raw);
  if (current.success) return current.data;

  const legacy = legacyPersistedWindowStateSchema.safeParse(raw);
  if (!legacy.success) return undefined;
  const state = legacy.data;

  const carryOver = {
    ...(state.manualName !== undefined ? { manualName: state.manualName } : {}),
    ...(state.lastAppliedName !== undefined ? { lastAppliedName: state.lastAppliedName } : {}),
    ...(state.callTimes ? { callTimes: state.callTimes } : {}),
    ...(state.lastCallAt !== undefined ? { lastCallAt: state.lastCallAt } : {}),
  };

  if (!state.record) {
    return {
      version: CURRENT_PERSISTED_VERSION,
      mode: state.mode,
      revision: state.revision,
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(state.accepted ? { accepted: state.accepted } : {}),
      ...carryOver,
    };
  }

  const task = normalizeTask(state.record.task);
  const validTask = task.length > 0 && isValidTask(task);
  if (!validTask && state.record.task !== "") {
    // Corrupt or unrepairable legacy Task text: drop the record entirely
    // rather than guess at it. This never overwrites a visible name -- it
    // is treated exactly like no persisted record at all.
    return {
      version: CURRENT_PERSISTED_VERSION,
      mode: state.mode,
      revision: state.revision,
      ...carryOver,
    };
  }

  const becomesAccepted = (state.accepted ?? false) || (state.provenance === "ai" && validTask);
  return {
    version: CURRENT_PERSISTED_VERSION,
    mode: state.mode,
    revision: state.revision,
    record: { scope: { workspace: state.record.scope.workspace }, task: validTask ? task : "" },
    ...(state.provenance ? { provenance: state.provenance } : {}),
    ...(becomesAccepted ? { accepted: true } : {}),
    ...carryOver,
  };
};

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
  root?: string;
  facts: string[];
};

export type ScopeCandidates = ScopeCandidate[];

// ADR 0002 (D5): the model may propose a Task, ask to keep the previous one
// (only meaningful on an explicit refresh), or abstain outright. Abstention
// and "keep" are distinct, normal outcomes, not errors.
export const nameProposalSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("propose"),
      workspaceId: z.string(),
      task: z.string(),
      confidence: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ outcome: z.literal("keep") }).strict(),
  z.object({ outcome: z.literal("abstain") }).strict(),
]);

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

// ADR 0002: Workspace selection prefers a root whose directory contains the
// active pane's cwd (or equals it); this no longer feeds an Area, only the
// containment check used to pick between candidate Workspace roots.
const rootContains = (root: string, cwd: string): boolean => {
  if (!root || !cwd || !isAbsolute(root) || !isAbsolute(cwd)) return false;
  if (cleanPath(root) === cleanPath(cwd)) return true;
  const value = relative(cleanPath(root), cleanPath(cwd));
  return value !== "" && !value.startsWith(`..${sep}`) && value !== "..";
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
    return [
      {
        id: `workspace:${stableHash(workspace)}`,
        value: workspace,
        facts: ["tmux session context"],
      },
    ];
  }

  type WorkspaceRoot = { value: string; root: string | undefined; facts: string[] };
  const roots: WorkspaceRoot[] = [];
  const sessionRoot = snapshot.sessionPath ? cleanPath(snapshot.sessionPath) : undefined;
  const sessionOwnsActive = Boolean(
    sessionRoot &&
      snapshot.sessionName &&
      basename(sessionRoot) === snapshot.sessionName &&
      rootContains(sessionRoot, active.cwd),
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

  return workspaceRoots.map((candidate) => ({
    id: `workspace:${stableHash(candidate)}`,
    value: candidate.value,
    ...(candidate.root ? { root: candidate.root } : {}),
    facts: candidate.facts,
  }));
};

export const deterministicScope = (candidates: ScopeCandidates): Scope => {
  const workspace = candidates[0];
  return workspace ? { workspace: workspace.value } : { workspace: "shell" };
};

export const isGroundedScope = (scope: Scope, candidates: ScopeCandidates): boolean =>
  candidates.some((candidate) => candidate.value === scope.workspace);

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

// ADR 0003: the default display is Workspace/Task, with no Activity and no
// Area. `OLD_DEFAULT_DISPLAY_PROFILE` is kept only to recognize an
// unedited pre-upgrade default during migration (see
// `resolveDisplayProfile`).
export const DEFAULT_DISPLAY_PROFILE = "{scope}/{task}";
export const OLD_DEFAULT_DISPLAY_PROFILE = "{activity}:{scope}/{task}";

export type DisplayProfileDiagnostic = "display_profile_activity_unsupported";

export type DisplayProfileResolution = {
  profile: string;
  diagnostic?: DisplayProfileDiagnostic;
};

// D6: a custom display template containing {activity} is not silently
// rewritten or dropped -- it gets an actionable diagnostic and renders with
// the new default profile until the user fixes the template. A profile
// left exactly at the old built-in default (never customized by the user)
// migrates silently to the new default instead, since that is a stale
// literal rather than an intentional customization.
export const resolveDisplayProfile = (profile: string): DisplayProfileResolution => {
  if (profile === OLD_DEFAULT_DISPLAY_PROFILE) return { profile: DEFAULT_DISPLAY_PROFILE };
  if (/\{activity\}/u.test(profile)) {
    return { profile: DEFAULT_DISPLAY_PROFILE, diagnostic: "display_profile_activity_unsupported" };
  }
  return { profile };
};

export const renderName = (
  record: NameRecord,
  profile = DEFAULT_DISPLAY_PROFILE,
): string => {
  const values: Record<string, string> = {
    scope: record.scope.workspace,
    task: record.task,
  };
  const rendered = profile.replace(
    /\{(scope|task)\}/g,
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

// Deterministic repair (D7): lowercase, strip stray punctuation, and collapse
// whitespace/hyphen runs before validation, so minor model formatting slips
// don't need a fresh model call to fix.
export const normalizeTask = (task: string): string =>
  task
    .trim()
    .toLowerCase()
    .replace(/['"“”‘’.,!?;:()[\]{}]/gu, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");

// Self-referential/apology tokens are never part of a legitimate task slug,
// so they are refusal-shaped wherever in the slug they appear.
const refusalAnywhereKeywords = [
  "sorry",
  "apologize",
  "apologies",
  "cannot",
  "cant",
  "unable",
  "refuse",
  "as-an-ai",
  "i-am-an-ai",
  "im-an-ai",
  "language-model",
  "large-language-model",
  "ai-assistant",
  "ai-model",
  "chatbot",
];

// These framing phrases only signal a refusal-shaped response (for example
// "Here is the task I was given" or "The task is unclear") when they open
// the slug. "task" is core domain vocabulary, so matching them mid-slug
// would reject legitimate task names like "review-the-task-queue".
const refusalPrefixKeywords = ["here-is", "the-task", "task-is", "no-task"];

// Anchor each keyword between hyphens so multi-word keywords (e.g.
// "as-an-ai") and single-word ones alike only match whole slug tokens.
const isRefusalShaped = (task: string): boolean => {
  const padded = `-${task}-`;
  if (refusalAnywhereKeywords.some((keyword) => padded.includes(`-${keyword}-`))) return true;
  return refusalPrefixKeywords.some(
    (keyword) => task === keyword || task.startsWith(`${keyword}-`),
  );
};

export const isValidTask = (task: string): boolean => {
  if (/[\u0000-\u001f\u007f\u001b]/u.test(task)) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,4}$/.test(task)) {
    return false;
  }
  return !isRefusalShaped(task);
};

export type ProposalResolution =
  | { kind: "accepted"; record: NameRecord }
  | { kind: "kept" }
  | { kind: "abstained" };

// ADR 0002 (D5, D7): turns a raw model proposal into one of three normal
// outcomes. "kept" is only meaningful on an explicit refresh with a
// previous Task to keep (D5); anything else -- a bare "keep" with nothing
// to keep, a "keep" returned for a non-refresh (automatic) trigger, a
// below-threshold proposal, an ungrounded workspace id, or a task slug that
// is still refusal-shaped after deterministic repair -- resolves to
// abstention rather than an error, per D5/D7.
export const resolveProposal = (
  proposal: NameProposal,
  request: NameRequest,
  confidenceThreshold: number,
): ProposalResolution => {
  if (proposal.outcome === "abstain") return { kind: "abstained" };
  if (proposal.outcome === "keep") {
    return request.event.kind === "refresh_requested" && request.previous?.task
      ? { kind: "kept" }
      : { kind: "abstained" };
  }

  if (proposal.confidence < confidenceThreshold) return { kind: "abstained" };
  const workspace = request.candidates.find((candidate) => candidate.id === proposal.workspaceId);
  if (!workspace) return { kind: "abstained" };

  // D7: repair deterministic formatting slips before validation; a slug
  // that is still refusal-shaped (or empty) after repair is abstention.
  const task = normalizeTask(proposal.task);
  if (!task || !isValidTask(task)) return { kind: "abstained" };

  return {
    kind: "accepted",
    record: {
      scope: { workspace: workspace.value },
      task,
    },
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

export const isMeaningfulCommand = (commandName: string | undefined): boolean => {
  if (!commandName) return false;
  return !new Set(["cd", "ls", "pwd", "clear", "exit", "true", "echo"]).has(
    commandName.toLowerCase(),
  );
};
