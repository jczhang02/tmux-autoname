import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  badgeText,
  buildScopeCandidates,
  deterministicScope,
  evidenceFingerprint,
  isValidTask,
  normalizeTask,
  renderName,
  type NameRequest,
} from "../src/domain";
import { AutonameRuntime, SecretUnavailableError } from "../src/runtime";
import {
  FakeClock,
  FakeModel,
  FakeTmux,
  deferred,
  flush,
  proposalFor,
  windowSnapshot,
} from "./helpers";

const config = () => {
  const value = defaultConfig();
  value.limits.debounce_ms = 10;
  value.limits.minimum_call_interval_ms = 0;
  value.limits.request_timeout_ms = 1000;
  return value;
};

const event = (
  kind:
    | "window_changed"
    | "content_settled"
    | "refresh_requested"
    | "manual_name_changed",
  extra: Record<string, unknown> = {},
) => ({
  version: 1 as const,
  source: "test" as const,
  kind,
  windowId: "@1",
  ...extra,
});

describe("AutonameRuntime interface", () => {
  test("renders nested Scope immediately and uses the active pane for Activity", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        panes: [
          {
            id: "%1",
            active: false,
            cwd: "/tmp",
            command: "pytest",
            pid: 10,
            title: "support",
          },
          windowSnapshot().panes[0]!,
        ],
      }),
    );
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    await runtime.handle(event("window_changed"));

    expect(tmux.get("@1").windowName).toBe(
      "codex:partjobs/high-value-patent-rebuild/manuscript",
    );
    expect(model.calls).toHaveLength(0);
  });

  test("generates from settled terminal content and deduplicates identical evidence", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    tmux.setContent("%1", "User: Please redesign the tmux naming plugin\nCodex: Working...");
    await runtime.handle(event("content_settled", { paneId: "%1" }));
    await runtime.handle(event("content_settled", { paneId: "%1" }));
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.terminalContext).toContain("Please redesign");
    expect(model.calls[0]?.previousProvenance).toBe("fallback");
    expect(tmux.get("@1").windowName).toBe(
      "codex:partjobs/high-value-patent-rebuild/manuscript/redesign-naming-plugin",
    );
  });

  test("an inactive pane event still uses only the active pane for naming", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        panes: [
          windowSnapshot().panes[0]!,
          {
            id: "%2",
            active: false,
            cwd: "/tmp/other",
            command: "pytest",
            pid: 200,
            title: "other",
          },
        ],
      }),
    );
    tmux.setContent("%1", "User: redesign the active window naming flow");
    tmux.setContent("%2", "unrelated inactive pane task");
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle({
      version: 1,
      source: "test",
      kind: "content_settled",
      paneId: "%2",
    });
    await clock.advance(10);

    expect(model.calls[0]?.terminalContext).toContain("active window naming");
    expect(model.calls[0]?.terminalContext).not.toContain("inactive pane task");
    expect(model.calls[0]?.activity).toBe("codex");
  });

  test("does not call AI when unchanged evidence is selected repeatedly", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("window_changed"));
    await runtime.handle(event("window_changed"));
    await clock.advance(100);

    expect(model.calls).toHaveLength(0);
  });

  test("concurrent automatic hooks cannot misclassify a plugin rename as manual", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await Promise.all([
      runtime.handle(event("window_changed")),
      runtime.handle(event("window_changed")),
    ]);

    expect((await runtime.explain({ windowId: "@1" })).mode).toBe("automatic");
  });

  test("a delayed hook for an older plugin name stays automatic", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await runtime.handle(event("window_changed"));
    const provisional = tmux.get("@1").windowName;
    await runtime.handle(event("refresh_requested"));
    await runtime.handle(event("manual_name_changed", { manualName: provisional }));

    expect((await runtime.explain({ windowId: "@1" })).mode).toBe("automatic");
  });

  test("changed terminal content can replace the task without an agent extension", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    tmux.setContent("%1", "User: investigate daemon resource usage");
    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.terminalContext).toContain("resource usage");
  });

  test("rejects an older model result that finishes after a forced refresh", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const first = deferred<ReturnType<typeof proposalFor>>();
    const second = deferred<ReturnType<typeof proposalFor>>();
    let modelCall = 0;
    const model = new FakeModel(() => {
      modelCall += 1;
      return modelCall === 1 ? first.promise : second.promise;
    });
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);

    const refresh = runtime.handle(event("refresh_requested"));
    await flush();
    expect(model.calls).toHaveLength(2);

    second.resolve(proposalFor(model.calls[1]!, "finish current design"));
    const outcome = await refresh;
    expect(outcome.kind).toBe("applied");
    expect(outcome.name).toEndWith("/finish-current-design");
    first.resolve(proposalFor(model.calls[0]!, "apply stale design"));
    await flush();

    expect(tmux.get("@1").windowName).toEndWith("/finish-current-design");
    expect(tmux.get("@1").windowName).not.toContain("stale");
  });

  test("late AI cannot overwrite a Manual Name", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const pending = deferred<ReturnType<typeof proposalFor>>();
    const model = new FakeModel(() => pending.promise);
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    tmux.get("@1").windowName = "my manual work";
    await runtime.handle(event("manual_name_changed", { manualName: "my manual work" }));
    pending.resolve(proposalFor(model.calls[0]!));
    await flush();

    expect(tmux.get("@1").windowName).toBe("my manual work");
    const report = await runtime.explain({ windowId: "@1" });
    expect(report.mode).toBe("manual");
    expect(report.badge.text).toBe("M");

    await runtime.handle(event("manual_name_changed", { manualName: "" }));
    expect((await runtime.explain({ windowId: "@1" })).mode).toBe("automatic");
  });

  test("rejects a result when the tmux server identity changes", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const pending = deferred<ReturnType<typeof proposalFor>>();
    const model = new FakeModel(() => pending.promise);
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    const fallback = tmux.get("@1").windowName;
    tmux.get("@1").serverId = "replacement-server";
    pending.resolve(proposalFor(model.calls[0]!));
    await flush();

    expect(tmux.get("@1").windowName).toBe(fallback);
  });

  test("evicting a tracked window clears a stale generating badge instead of leaving it stuck", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot({ windowId: "@1" }));
    const pendingFirst = deferred<ReturnType<typeof proposalFor>>();
    const model = new FakeModel((request) =>
      request.windowId === "@1" ? pendingFirst.promise : Promise.resolve(proposalFor(request)),
    );
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    // Put @1 into the "generating" badge state via an in-flight AI call that
    // never resolves, then age it out of the runtime's tracked-window cache
    // by touching enough other windows to reach MAX_RUNTIME_WINDOWS.
    await runtime.handle(event("content_settled", { windowId: "@1" }));
    expect((await runtime.explain({ windowId: "@1" })).badge.state).toBe("generating");

    for (let index = 2; index <= 257; index += 1) {
      const windowId = `@${index}`;
      tmux.add(
        windowSnapshot({
          windowId,
          sessionName: `proj${index}`,
          sessionPath: `/tmp/proj${index}`,
          panes: [
            {
              id: `%${index}`,
              active: true,
              cwd: `/tmp/proj${index}`,
              command: "zsh",
              pid: 100 + index,
              title: "zsh",
            },
          ],
        }),
      );
      await runtime.handle(event("window_changed", { windowId }));
    }

    const badgesFor1 = tmux.badges.filter((entry) => entry.windowId === "@1");
    expect(badgesFor1.at(-1)?.badge).toBe(badgeText("healthy", "plain"));
    expect(badgesFor1.some((entry) => entry.badge === badgeText("generating", "plain"))).toBe(
      true,
    );
  });

  test("restores automatic quotas across daemon runtime restarts", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const limits = config();
    limits.limits.max_calls_per_window_hour = 1;
    const firstModel = new FakeModel();
    const first = new AutonameRuntime({ tmux, model: firstModel, clock, config: limits });

    await first.handle(event("window_changed"));
    tmux.setPath("@1", "/home/jc/dev/partjobs/first-quota-path");
    await first.handle(event("window_changed"));
    await clock.advance(10);
    expect(firstModel.calls).toHaveLength(1);

    const secondModel = new FakeModel();
    const second = new AutonameRuntime({ tmux, model: secondModel, clock, config: limits });
    await second.explain({ windowId: "@1" });
    tmux.setPath("@1", "/home/jc/dev/partjobs/second-quota-path");
    await second.handle(event("window_changed"));
    await clock.advance(10);

    expect(secondModel.calls).toHaveLength(0);
    expect((await second.explain({ windowId: "@1" })).limits).toMatchObject({
      windowCallsLastHour: 1,
      serverCallsLastHour: 1,
    });
  });

  test("explicit refresh cannot bypass the hourly model-call quota", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const limits = config();
    limits.limits.max_calls_per_window_hour = 1;
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: limits });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    await runtime.handle(event("refresh_requested"));
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).limits.windowCallsLastHour).toBe(1);
  });

  test("explicit refresh waits for the final name", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome).toEqual({
      kind: "applied",
      windowId: "@1",
      name: "codex:partjobs/high-value-patent-rebuild/manuscript/redesign-naming-plugin",
    });
    expect(model.calls).toHaveLength(1);
  });

  test("normal terminal output during a refresh does not discard the result", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel(async (request) => {
      tmux.setContent("%1", "provider request completed");
      return proposalFor(request);
    });
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome.kind).toBe("applied");
  });

  test("a restarted runtime clears a stale badge on first reconciliation", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        windowName:
          "codex:partjobs/high-value-patent-rebuild/manuscript/redesign naming plugin",
        persisted: {
          mode: "automatic",
          revision: 2,
          record: {
            scope: { workspace: "partjobs", area: "high-value-patent-rebuild/manuscript" },
            task: "redesign naming plugin",
            activity: "codex",
          },
          provenance: "ai",
          lastAppliedName:
            "codex:partjobs/high-value-patent-rebuild/manuscript/redesign naming plugin",
        },
      }),
    );
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await runtime.handle(event("window_changed"));

    expect(tmux.badges.at(-1)).toEqual({ windowId: "@1", badge: "" });
    expect(tmux.get("@1").windowName).toBe(
      "codex:partjobs/high-value-patent-rebuild/manuscript/redesign-naming-plugin",
    );
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe(
      "redesign-naming-plugin",
    );
  });

  test("a restarted runtime replaces an ungrounded persisted Scope", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        sessionName: "tmux-autoname",
        sessionPath: "/home/jc",
        panes: [
          {
            ...windowSnapshot().panes[0]!,
            cwd: "/home/jc/dev/tmux-autoname",
            gitRoot: "/home/jc/dev/tmux-autoname",
          },
        ],
        persisted: {
          mode: "automatic",
          revision: 2,
          record: {
            scope: { workspace: "tmux-autoname", area: "dev/tmux-autoname" },
            task: "debug old scope",
            activity: "codex",
          },
          provenance: "ai",
          lastAppliedName: "codex:tmux-autoname/dev/tmux-autoname/debug old scope",
        },
      }),
    );
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await runtime.handle(event("window_changed"));
    const report = await runtime.explain({ windowId: "@1" });

    expect(report.record).toMatchObject({ scope: { workspace: "tmux-autoname" }, task: "" });
    expect(report.record?.scope.area).toBeUndefined();
    expect(report.provenance).toBe("fallback");
  });

  test("credential reload closes the circuit without resetting quotas", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        serverPersisted: {
          callTimes: [0, 1],
          consecutiveFailures: 3,
          circuitOpenUntil: 10_000,
        },
      }),
    );
    const clock = new FakeClock();
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), clock, config: config() });
    await runtime.explain({ windowId: "@1" });

    await runtime.resetFailures();
    const report = await runtime.explain({ windowId: "@1" });

    expect(report.limits.serverCallsLastHour).toBe(2);
    expect(report.limits.circuitOpenUntil).toBeUndefined();
    expect(tmux.serverState).toMatchObject({ callTimes: [0, 1], consecutiveFailures: 0 });
  });

  test("model and credential failure retain fallback names", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel(async () => {
      throw new SecretUnavailableError();
    });
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    const fallback = tmux.get("@1").windowName;
    await clock.advance(10);

    expect(tmux.get("@1").windowName).toBe(fallback);
    expect((await runtime.explain({ windowId: "@1" })).badge.text).toBe("K!");
  });

  test("profile and badge style re-render without calling AI", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    await runtime.handle(event("window_changed"));
    tmux.setProfile("@1", "{scope}:{activity}/{task}");
    tmux.setBadgeStyle("@1", "nerd");
    await runtime.handle(event("window_changed"));
    tmux.get("@1").windowName = "manual";
    await runtime.handle(event("manual_name_changed", { manualName: "manual" }));

    expect(tmux.renames.at(-1)?.name).toBe(
      "partjobs/high-value-patent-rebuild/manuscript:codex",
    );
    expect((await runtime.explain({ windowId: "@1" })).badge.text).toBe("");
    expect(model.calls).toHaveLength(0);
  });
});

describe("domain rules", () => {
  test("builds grounded nested candidates", () => {
    const candidates = buildScopeCandidates(windowSnapshot());
    expect(candidates.workspaces[0]?.value).toBe("partjobs");
    expect(candidates.areas[0]?.value).toBe(
      "high-value-patent-rebuild/manuscript",
    );
  });

  test("uses the git root when the tmux session path is only the home directory", () => {
    const snapshot = windowSnapshot({
      sessionName: "tmux-autoname",
      sessionPath: "/home/jc",
      panes: [
        {
          ...windowSnapshot().panes[0]!,
          cwd: "/home/jc/dev/tmux-autoname",
          gitRoot: "/home/jc/dev/tmux-autoname",
        },
      ],
    });

    const candidates = buildScopeCandidates(snapshot);
    expect(candidates.workspaces[0]?.value).toBe("tmux-autoname");
    expect(candidates.workspaces.map((candidate) => candidate.value)).not.toContain("jc");
    expect(candidates.areas.find((candidate) => candidate.workspaceId === candidates.workspaces[0]?.id))
      .toBeUndefined();
  });

  test("keeps a deliberate sesh session as Workspace across a nested git repository", () => {
    const candidates = buildScopeCandidates(
      windowSnapshot({
        panes: [
          {
            ...windowSnapshot().panes[0]!,
            cwd: "/home/jc/dev/partjobs/client-a/service",
            gitRoot: "/home/jc/dev/partjobs/client-a",
          },
        ],
      }),
    );

    expect(candidates.workspaces[0]?.value).toBe("partjobs");
    expect(candidates.areas[0]).toMatchObject({
      value: "client-a/service",
      workspaceId: candidates.workspaces[0]?.id,
    });
  });

  test("does not attach an outside cwd suffix to an unrooted session Workspace", () => {
    const snapshot = windowSnapshot({
      sessionName: "tmux-autoname",
      sessionPath: "/home/jc/dev/tmux-autoname",
      sessionCwds: [
        "/home/jc/dev/tmux-autoname",
        "/home/jc/.config/tmux-autoname",
      ],
      panes: [
        {
          ...windowSnapshot().panes[0]!,
          cwd: "/home/jc/.config/tmux-autoname",
          gitRoot: undefined,
        },
      ],
    });

    expect(deterministicScope(buildScopeCandidates(snapshot))).toEqual({
      workspace: "tmux-autoname",
    });
  });

  test("uses supporting panes, remote hosts, common ancestors, and grounded areas", () => {
    const active = {
      ...windowSnapshot().panes[0]!,
      cwd: "/home/jc/dev/partjobs/alpha/service",
      gitRoot: "/home/jc/dev/partjobs/alpha",
      command: "ssh",
      remoteHost: "build.example.com",
    };
    const supporting = {
      ...active,
      id: "%2",
      active: false,
      cwd: "/home/jc/dev/partjobs/beta/docs",
      gitRoot: "/home/jc/dev/partjobs/beta",
      command: "nvim",
      remoteHost: undefined,
    };
    const candidates = buildScopeCandidates(
      windowSnapshot({
        sessionPath: "/home/jc/dev",
        panes: [active, supporting],
        sessionCwds: [active.cwd, supporting.cwd],
      }),
    );

    const workspaceValues = candidates.workspaces.map((candidate) => candidate.value);
    expect(workspaceValues).toContain("build.example.com");
    expect(workspaceValues).toContain("beta");
    expect(workspaceValues).toContain("partjobs");
    expect(candidates.workspaces.some((candidate) => candidate.facts.includes("supporting pane cwd")))
      .toBe(true);
    expect(candidates.areas.every((candidate) => candidate.workspaceId)).toBe(true);
  });

  test("renders full names and leaves truncation to tmux", () => {
    expect(
      renderName({
        scope: { workspace: "partjobs", area: "a/very/long/manuscript/path" },
        task: "rewrite-patent-draft",
        activity: "nvim",
      }),
    ).toBe("nvim:partjobs/a/very/long/manuscript/path/rewrite-patent-draft");
  });

  test("ignores shell prompt redraws when deduplicating evidence", () => {
    const snapshot = windowSnapshot();
    const candidates = buildScopeCandidates(snapshot);
    const first = evidenceFingerprint(
      snapshot,
      candidates,
      "Task: Please redesign the naming plugin%",
    );
    const redrawn = evidenceFingerprint(
      snapshot,
      candidates,
      "Task: Please redesign the naming plugin%\n╭─ /tmp/work 0.68 16.6G ─╮\n╰─ Task: Please redesign the naming plugin ─╯",
    );

    expect(redrawn).toBe(first);
  });

  test("validates English action phrases and both badge sets", () => {
    expect(isValidTask("rewrite-naming-plugin")).toBe(true);
    expect(isValidTask("rewrite naming plugin")).toBe(false);
    expect(isValidTask("here-is-a-title")).toBe(false);
    expect(isValidTask("sorry-cannot-help")).toBe(false);
    expect(badgeText("generating", "plain")).toBe("…");
    expect(badgeText("generating", "nerd")).toBe("󰚩");
  });

  test("repairs deterministic formatting slips before validation (D7)", () => {
    expect(normalizeTask("  Rewrite   Naming Plugin  ")).toBe("rewrite-naming-plugin");
    expect(normalizeTask("Fix the bug.")).toBe("fix-the-bug");
    expect(normalizeTask("Add \"quotes\" support!")).toBe("add-quotes-support");
    expect(normalizeTask("collapse--repeated---hyphens")).toBe("collapse-repeated-hyphens");
    expect(normalizeTask("-leading-and-trailing-")).toBe("leading-and-trailing");
    expect(isValidTask(normalizeTask("  Rewrite   Naming Plugin  "))).toBe(true);
  });

  test("detects refusal-shaped slugs anywhere in the slug, not just as a prefix", () => {
    expect(isValidTask("i-cannot-help-with-this")).toBe(false);
    expect(isValidTask("please-forgive-me-sorry-about-that")).toBe(false);
    expect(isValidTask("as-an-ai-i-cannot-comply")).toBe(false);
    expect(isValidTask("rewrite-the-naming-plugin-cannot-fail")).toBe(false);
    expect(isValidTask("i-am-an-ai-language-model")).toBe(false);
    // A legitimate task must still pass even though it shares a substring
    // with a refusal keyword (e.g. "cant" inside "recant" is not a match).
    expect(isValidTask("recant-the-old-config")).toBe(true);
    expect(isValidTask("rewrite-naming-plugin")).toBe(true);
  });

  test("only treats framing phrases like 'the-task' as refusal-shaped at the start of the slug", () => {
    // "task" is core domain vocabulary (every window names a task), so
    // matching these phrases mid-slug would reject ordinary task names.
    expect(isValidTask("review-the-task-queue")).toBe(true);
    expect(isValidTask("update-the-task-list")).toBe(true);
    expect(isValidTask("define-task-issue-tracker")).toBe(true);
    // Still refusal-shaped when the phrase opens the slug.
    expect(isValidTask("the-task-is-unclear-please-specify")).toBe(false);
    expect(isValidTask("here-is-the-summary-you-wanted")).toBe(false);
    expect(isValidTask("no-task-detected-in-this-window")).toBe(false);
    expect(isValidTask("task-is-not-defined-correctly")).toBe(false);
  });
});
