// STAGE 5: offline naming-quality eval fixtures. Shared between the
// deterministic unit test (test/eval.test.ts, part of `bun run test`) and
// the opt-in harness (test/eval/run.ts, `bun run eval`) that scores real
// model output against these expectations.
import { z } from "zod";
import { eventKinds, type NameRequest } from "../../src/domain";

const paneEvidenceSchema = z.object({
  cwd: z.string(),
  command: z.string(),
  title: z.string(),
});

const scopeCandidateSchema = z.object({
  id: z.string(),
  value: z.string(),
  root: z.string().optional(),
  facts: z.array(z.string()),
});

export const fixtureSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  category: z.enum([
    "coding-agent",
    "editor",
    "test-run",
    "ssh",
    "writing",
    "ambiguous",
  ]),
  // Fixtures sharing a stabilityGroup are near-duplicate evidence for the
  // same underlying goal; the harness scores whether the model reaches the
  // same kind of outcome across the group instead of flipping on cosmetic
  // reruns.
  stabilityGroup: z.string().optional(),
  request: z.object({
    previous: z
      .object({ scope: z.object({ workspace: z.string() }), task: z.string() })
      .optional(),
    previousProvenance: z.enum(["fallback", "ai"]).optional(),
    activity: z.string(),
    candidates: z.array(scopeCandidateSchema).min(1),
    event: z.object({
      kind: z.enum(eventKinds),
      commandName: z.string().optional(),
      exitCode: z.number().int().optional(),
    }),
    activePane: paneEvidenceSchema,
    terminalContext: z.string(),
    supportingPanes: z.array(paneEvidenceSchema).default([]),
  }),
  expect: z.object({
    abstain: z.boolean(),
    // Acceptable Task keywords: a propose outcome is scored a keyword match
    // if the task slug contains at least one of these words.
    keywords: z.array(z.string()).optional(),
    // Set only for a refresh fixture with a still-fitting previous Task,
    // where "keep" is as correct an outcome as re-proposing it (D5).
    allowKeep: z.boolean().optional(),
  }),
});

export type EvalFixture = z.infer<typeof fixtureSchema>;

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

export const loadFixtures = async (): Promise<EvalFixture[]> => {
  const glob = new Bun.Glob("*.json");
  const files = [...glob.scanSync({ cwd: FIXTURES_DIR.pathname })].sort();
  const fixtures: EvalFixture[] = [];
  for (const file of files) {
    const text = await Bun.file(new URL(file, FIXTURES_DIR)).text();
    const parsed = fixtureSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`invalid eval fixture ${file}: ${parsed.error.message}`);
    }
    fixtures.push(parsed.data);
  }
  return fixtures;
};

/** Builds a full NameRequest from a fixture's evidence for a given ordinal. */
export const toNameRequest = (fixture: EvalFixture, index: number): NameRequest => {
  const { request } = fixture;
  return {
    serverId: "eval-server",
    windowId: `@eval${index}`,
    revision: 1,
    fingerprint: "",
    structureFingerprint: "",
    ...(request.previous ? { previous: request.previous } : {}),
    ...(request.previousProvenance ? { previousProvenance: request.previousProvenance } : {}),
    activity: request.activity,
    candidates: request.candidates,
    event: {
      version: 1,
      source: "test",
      windowId: `@eval${index}`,
      kind: request.event.kind,
      ...(request.event.commandName ? { commandName: request.event.commandName } : {}),
      ...(request.event.exitCode !== undefined ? { exitCode: request.event.exitCode } : {}),
    },
    activePane: request.activePane,
    terminalContext: request.terminalContext,
    supportingPanes: request.supportingPanes,
  };
};
