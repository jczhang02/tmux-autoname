import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  badgeText,
  buildScopeCandidates,
  isValidTask,
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
      "codex:partjobs/high-value-patent-rebuild/manuscript/redesign naming plugin",
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

    await runtime.handle(event("refresh_requested"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(2);

    second.resolve(proposalFor(model.calls[1]!, "finish current design"));
    await flush();
    first.resolve(proposalFor(model.calls[0]!, "apply stale design"));
    await flush();

    expect(tmux.get("@1").windowName).toEndWith("/finish current design");
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

  test("uses supporting panes, remote hosts, common ancestors, and session suffixes", () => {
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
    expect(
      candidates.areas.some((candidate) =>
        candidate.facts.includes("shortest distinguishing cwd suffix across session windows")
      ),
    ).toBe(true);
  });

  test("renders full names and leaves truncation to tmux", () => {
    expect(
      renderName({
        scope: { workspace: "partjobs", area: "a/very/long/manuscript/path" },
        task: "rewrite patent draft",
        activity: "nvim",
      }),
    ).toBe("nvim:partjobs/a/very/long/manuscript/path/rewrite patent draft");
  });

  test("validates English action phrases and both badge sets", () => {
    expect(isValidTask("rewrite naming plugin")).toBe(true);
    expect(isValidTask("Here is a title")).toBe(false);
    expect(isValidTask("sorry cannot help")).toBe(false);
    expect(badgeText("generating", "plain")).toBe("…");
    expect(badgeText("generating", "nerd")).toBe("󰚩");
  });
});
