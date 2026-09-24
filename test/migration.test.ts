import { describe, expect, test } from "bun:test";
import { decodePersistedWindowState, type PersistedWindowState } from "../src/domain";

// ADR 0003 upgrade migration: `decodePersistedWindowState` must turn a
// pre-ADR-0003 (unversioned) persisted Window state into the current
// (versioned, Area/Activity-free) shape without ever guessing at a Task it
// cannot validate, and must leave Manual Names and corrupt state alone.
describe("decodePersistedWindowState (ADR 0003 upgrade migration)", () => {
  test("a valid legacy AI Task becomes accepted without a new AI request, Area and Activity dropped", () => {
    const legacy = {
      mode: "automatic",
      revision: 3,
      record: {
        scope: { workspace: "partjobs", area: "high-value-patent-rebuild/manuscript" },
        task: "redesign naming plugin",
        activity: "codex",
      },
      provenance: "ai",
      lastAppliedName: "codex:partjobs/high-value-patent-rebuild/manuscript/redesign naming plugin",
    };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated).toEqual({
      version: 2,
      mode: "automatic",
      revision: 3,
      record: { scope: { workspace: "partjobs" }, task: "redesign-naming-plugin" },
      provenance: "ai",
      accepted: true,
      lastAppliedName:
        "codex:partjobs/high-value-patent-rebuild/manuscript/redesign naming plugin",
    });
  });

  test("a legacy record already marked accepted (post-ADR-0001, pre-ADR-0003) stays accepted, Area and Activity dropped", () => {
    const legacy = {
      mode: "automatic",
      revision: 5,
      record: {
        scope: { workspace: "tmux-autoname", area: "dev/tmux-autoname" },
        task: "ship-adr-0002",
        activity: "nvim",
      },
      provenance: "ai",
      accepted: true,
    };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated).toMatchObject({
      version: 2,
      accepted: true,
      record: { scope: { workspace: "tmux-autoname" }, task: "ship-adr-0002" },
    });
    expect((migrated?.record as { area?: string })?.area).toBeUndefined();
  });

  test("a still-provisional (Workspace-only) legacy record stays unaccepted, Workspace retained", () => {
    const legacy = {
      mode: "automatic",
      revision: 1,
      record: {
        scope: { workspace: "partjobs" },
        task: "",
        activity: "zsh",
      },
      provenance: "fallback",
    };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated).toEqual({
      version: 2,
      mode: "automatic",
      revision: 1,
      record: { scope: { workspace: "partjobs" }, task: "" },
      provenance: "fallback",
    });
  });

  test("a legacy Manual Name is untouched, even alongside a migrated automatic record", () => {
    const legacy = {
      mode: "manual",
      revision: 4,
      manualName: "my manual work",
      record: {
        scope: { workspace: "partjobs", area: "manuscript" },
        task: "old-automatic-task",
        activity: "codex",
      },
      provenance: "ai",
      accepted: true,
    };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated?.mode).toBe("manual");
    expect(migrated?.manualName).toBe("my manual work");
    expect(migrated?.record).toEqual({ scope: { workspace: "partjobs" }, task: "old-automatic-task" });
  });

  test("a corrupt (still refusal-shaped after repair) legacy Task is dropped rather than guessed at", () => {
    const legacy = {
      mode: "automatic",
      revision: 2,
      record: {
        scope: { workspace: "partjobs" },
        task: "sorry-i-cannot-help",
        activity: "codex",
      },
      provenance: "ai",
    };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated).toEqual({
      version: 2,
      mode: "automatic",
      revision: 2,
    });
  });

  test("a legacy state with no record at all passes through with no record", () => {
    const legacy = { mode: "automatic", revision: 0, callTimes: [1000] };

    const migrated = decodePersistedWindowState(legacy);

    expect(migrated).toEqual({ version: 2, mode: "automatic", revision: 0, callTimes: [1000] });
  });

  test("completely unparseable state decodes to undefined, identical to no persisted state -- it can never overwrite a visible name", () => {
    expect(decodePersistedWindowState({ garbage: true })).toBeUndefined();
    expect(decodePersistedWindowState("not even an object")).toBeUndefined();
    expect(decodePersistedWindowState(null)).toBeUndefined();
  });

  test("an already-current (versioned) state round-trips unchanged", () => {
    const current: PersistedWindowState = {
      version: 2,
      mode: "automatic",
      revision: 7,
      record: { scope: { workspace: "partjobs" }, task: "ship-stage-4" },
      provenance: "ai",
      accepted: true,
      lastAppliedName: "partjobs/ship-stage-4",
    };

    expect(decodePersistedWindowState(current)).toEqual(current);
  });
});
