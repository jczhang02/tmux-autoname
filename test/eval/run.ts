#!/usr/bin/env bun
// offline naming-quality eval. Runs test/eval/fixtures/*.json
// through the real, configured model (src/config.ts / src/adapters.ts) and
// scores validity, keyword match, abstention correctness, and stability
// across near-duplicate evidence.
//
// Opt-in only, like the soak test (TMUX_AUTONAME_RUN_SOAK): this never runs
// as part of `bun run test`. Invoke it with:
//   bun run eval
import { AiSdkModel } from "../../src/adapters";
import { loadConfig } from "../../src/config";
import { isValidTask, normalizeTask } from "../../src/domain";
import { loadFixtures, toNameRequest, type EvalFixture } from "./fixtures";

const OPT_IN_ENV = "TMUX_AUTONAME_RUN_EVAL";
const REQUEST_TIMEOUT_MS = 30_000;

type Outcome = "propose" | "keep" | "abstain" | "error";

type Result = {
  fixture: EvalFixture;
  outcome: Outcome;
  task?: string;
  confidence?: number;
  valid: boolean;
  keywordMatch?: boolean;
  abstainCorrect: boolean;
};

const scoreFixture = async (
  model: AiSdkModel,
  fixture: EvalFixture,
  index: number,
): Promise<Result> => {
  const request = toNameRequest(fixture, index);
  try {
    const proposal = await model.propose(request, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (proposal.outcome === "propose") {
      const task = normalizeTask(proposal.task);
      const words = new Set(task.split("-"));
      const keywordMatch = fixture.expect.keywords
        ? fixture.expect.keywords.some((keyword) => words.has(keyword))
        : undefined;
      return {
        fixture,
        outcome: "propose",
        task,
        confidence: proposal.confidence,
        valid: isValidTask(task),
        ...(keywordMatch !== undefined ? { keywordMatch } : {}),
        abstainCorrect: !fixture.expect.abstain,
      };
    }
    if (proposal.outcome === "keep") {
      return {
        fixture,
        outcome: "keep",
        valid: true,
        abstainCorrect: !fixture.expect.abstain && (fixture.expect.allowKeep ?? false),
      };
    }
    return { fixture, outcome: "abstain", valid: true, abstainCorrect: fixture.expect.abstain };
  } catch (error) {
    process.stderr.write(
      `${fixture.id}: request failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return { fixture, outcome: "error", valid: false, abstainCorrect: false };
  }
};

const scoreStability = (results: Result[]): { groups: number; stable: number } => {
  const groups = new Map<string, Result[]>();
  for (const result of results) {
    const group = result.fixture.stabilityGroup;
    if (!group) continue;
    const members = groups.get(group) ?? [];
    members.push(result);
    groups.set(group, members);
  }
  let stable = 0;
  for (const [group, members] of groups) {
    // "keep" and "propose" both count as a non-abstaining goal identification
    // for stability purposes -- only flipping into/out of abstention, or
    // between genuinely different tasks, is instability.
    const shapes = new Set(members.map((member) => (member.outcome === "keep" ? "propose" : member.outcome)));
    const isStable = shapes.size === 1;
    if (isStable) stable += 1;
    process.stdout.write(
      `stability [${group}]: ${isStable ? "stable" : "UNSTABLE"} (${members
        .map((member) => member.task ?? member.outcome)
        .join(" | ")})\n`,
    );
  }
  return { groups: groups.size, stable };
};

const main = async (): Promise<number> => {
  if (process.env[OPT_IN_ENV] !== "1") {
    process.stdout.write(
      `Offline naming eval is opt-in and calls the model configured in your tmux-autoname\n` +
        `config file (see README.md "Configure AI"). Run it explicitly with:\n` +
        `  ${OPT_IN_ENV}=1 bun run eval\n`,
    );
    return 0;
  }

  const config = await loadConfig();
  if (!config.ai) {
    process.stderr.write("no [ai] provider is configured; cannot run the eval against a real model\n");
    return 1;
  }

  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    process.stderr.write("no fixtures found under test/eval/fixtures\n");
    return 1;
  }

  const model = new AiSdkModel(config.ai);
  const results: Result[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    results.push(await scoreFixture(model, fixture, index));
  }

  for (const result of results) {
    const detail = result.outcome === "propose"
      ? `${result.task} (confidence ${result.confidence?.toFixed(2)})`
      : result.outcome;
    process.stdout.write(
      `${result.fixture.id}: ${detail} -- valid=${result.valid} ` +
        `keywordMatch=${result.keywordMatch ?? "n/a"} abstainCorrect=${result.abstainCorrect}\n`,
    );
  }

  const { groups, stable } = scoreStability(results);
  const total = results.length;
  const validCount = results.filter((result) => result.valid).length;
  const abstainCorrectCount = results.filter((result) => result.abstainCorrect).length;
  const keywordResults = results.filter((result) => result.keywordMatch !== undefined);
  const keywordMatchCount = keywordResults.filter((result) => result.keywordMatch).length;

  process.stdout.write(
    `\nvalidity ${validCount}/${total}, abstention-correctness ${abstainCorrectCount}/${total}, ` +
      `keyword-match ${keywordMatchCount}/${keywordResults.length}, ` +
      `stability ${stable}/${groups}\n`,
  );

  return 0;
};

process.exitCode = await main();
