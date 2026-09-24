// deterministic coverage for the offline naming eval. This never
// calls a real model -- it only checks that every fixture parses and that
// the prompt builder handles it without throwing. The real scoring harness
// (`bun run eval`) is opt-in, like the soak test, and is not part of this
// suite.
import { describe, expect, test } from "bun:test";
import { modelPrompt } from "../src/adapters";
import { loadFixtures, toNameRequest } from "./eval/fixtures";

describe("offline eval fixtures", () => {
  test("covers at least 12 fixtures across realistic and ambiguous categories", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    const categories = new Set(fixtures.map((fixture) => fixture.category));
    expect(categories.has("coding-agent")).toBe(true);
    expect(categories.has("editor")).toBe(true);
    expect(categories.has("test-run")).toBe(true);
    expect(categories.has("ssh")).toBe(true);
    expect(categories.has("writing")).toBe(true);
    expect(categories.has("ambiguous")).toBe(true);

    const ids = fixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every fixture that expects a propose outcome lists acceptable keywords", async () => {
    const fixtures = await loadFixtures();
    for (const fixture of fixtures) {
      if (fixture.expect.abstain) continue;
      expect(fixture.expect.keywords?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("fixtures sharing a stabilityGroup agree on the expected abstain outcome", async () => {
    const fixtures = await loadFixtures();
    const groups = new Map<string, boolean[]>();
    for (const fixture of fixtures) {
      if (!fixture.stabilityGroup) continue;
      const list = groups.get(fixture.stabilityGroup) ?? [];
      list.push(fixture.expect.abstain);
      groups.set(fixture.stabilityGroup, list);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [group, abstains] of groups) {
      expect(new Set(abstains).size, `stability group ${group} disagrees on abstain`).toBe(1);
    }
  });

  test("the prompt builder handles every fixture and includes its evidence", async () => {
    const fixtures = await loadFixtures();
    for (const [index, fixture] of fixtures.entries()) {
      const request = toNameRequest(fixture, index);
      const prompt = modelPrompt(request);
      expect(prompt).toContain('"outcome"');
      expect(prompt).toContain("propose");
      expect(prompt).toContain("abstain");
      if (fixture.request.terminalContext) {
        expect(prompt).toContain(
          JSON.stringify(fixture.request.terminalContext).slice(1, -1).slice(0, 40),
        );
      }
      if (fixture.request.previous) {
        expect(prompt).toContain(fixture.request.previous.task);
      }
    }
  });
});
