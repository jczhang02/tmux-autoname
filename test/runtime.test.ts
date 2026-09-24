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
import { AutonameRuntime, ProviderAuthenticationError, SecretUnavailableError } from "../src/runtime";
import {
  FakeClock,
  FakeModel,
  FakeTmux,
  abstainProposal,
  deferred,
  flush,
  keepProposal,
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
    | "manual_name_changed"
    | "new_work_requested",
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
      "partjobs",
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
      "partjobs/redesign-naming-plugin",
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

  // ADR 0001: automation may establish a Task from settled terminal content,
  // but once accepted it may never replace it again on further automatic
  // evidence, even genuinely new terminal content.
  test("settled terminal content establishes a Task once, then never replaces it automatically", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).accepted).toBe(true);

    tmux.setContent("%1", "User: investigate daemon resource usage");
    await runtime.handle(event("content_settled"));
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe(
      "redesign-naming-plugin",
    );
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
    // A genuine cross-Workspace move (outside the session root, with its own
    // Git root), not just a subdirectory change, so this is a valid
    // pre-acceptance trigger (ADR 0002).
    tmux.setPath("@1", "/tmp/first-quota-path", "/tmp/first-quota-path");
    await first.handle(event("window_changed"));
    await clock.advance(10);
    expect(firstModel.calls).toHaveLength(1);

    const secondModel = new FakeModel();
    const second = new AutonameRuntime({ tmux, model: secondModel, clock, config: limits });
    await second.explain({ windowId: "@1" });
    // The Task is now accepted, so even another Workspace move must not
    // call the model again (ADR 0001).
    tmux.setPath("@1", "/tmp/second-quota-path", "/tmp/second-quota-path");
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
      name: "partjobs/redesign-naming-plugin",
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

  test("a restarted runtime clears a stale badge and re-renders a persisted accepted record whose stored name is stale", async () => {
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        windowName: "partjobs/redesign naming plugin",
        persisted: {
          version: 2,
          mode: "automatic",
          revision: 2,
          record: { scope: { workspace: "partjobs" }, task: "redesign naming plugin" },
          provenance: "ai",
          accepted: true,
          lastAppliedName: "partjobs/redesign naming plugin",
        },
      }),
    );
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await runtime.handle(event("window_changed"));

    expect(tmux.badges.at(-1)).toEqual({ windowId: "@1", badge: "" });
    expect(tmux.get("@1").windowName).toBe(
      "partjobs/redesign-naming-plugin",
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
          version: 2,
          mode: "automatic",
          revision: 2,
          record: { scope: { workspace: "an-unrelated-workspace" }, task: "debug old scope" },
          provenance: "ai",
          lastAppliedName: "an-unrelated-workspace/debug old scope",
        },
      }),
    );
    const runtime = new AutonameRuntime({ tmux, model: new FakeModel(), config: config() });

    await runtime.handle(event("window_changed"));
    const report = await runtime.explain({ windowId: "@1" });

    expect(report.record).toMatchObject({ scope: { workspace: "tmux-autoname" }, task: "" });
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
    tmux.setProfile("@1", "<{scope}>");
    tmux.setBadgeStyle("@1", "nerd");
    await runtime.handle(event("window_changed"));
    tmux.get("@1").windowName = "manual";
    await runtime.handle(event("manual_name_changed", { manualName: "manual" }));

    expect(tmux.renames.at(-1)?.name).toBe("<partjobs>");
    expect((await runtime.explain({ windowId: "@1" })).badge.text).toBe("");
    expect(model.calls).toHaveLength(0);
  });

  // D6: a custom template containing {activity} is not silently rewritten
  // or dropped -- the window falls back to the default profile and an
  // actionable diagnostic surfaces in `explain`, distinct from the old
  // built-in default migrating silently (covered separately below).
  test("D6: a custom display profile containing {activity} falls back to the default and surfaces a diagnostic", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    tmux.setProfile("@1", "{activity}::{scope}/{task}");
    await runtime.handle(event("window_changed"));

    expect(tmux.get("@1").windowName).toBe("partjobs");
    const report = await runtime.explain({ windowId: "@1" });
    expect(report.displayDiagnostic).toBe("display_profile_activity_unsupported");
  });

  // D6: the diagnostic log must actually receive the diagnostic the very
  // first time a window is observed with a bad template, not only on a
  // later change -- `onDiagnostic` must not depend on the window state
  // having pre-existed without the diagnostic.
  test("D6: onDiagnostic fires once for a window whose very first observed state already has a bad template", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    tmux.setProfile("@1", "{activity}::{scope}/{task}");
    const model = new FakeModel();
    const diagnostics: string[] = [];
    const runtime = new AutonameRuntime({
      tmux,
      model,
      config: config(),
      onDiagnostic: (code) => diagnostics.push(code),
    });

    await runtime.handle(event("window_changed"));
    expect(diagnostics).toEqual(["display_profile_activity_unsupported"]);

    await runtime.handle(event("window_changed"));
    expect(diagnostics).toEqual(["display_profile_activity_unsupported"]);
  });

  // ADR 0003: a profile left exactly at the old built-in default (never
  // customized by the user) migrates silently to the new default -- no
  // diagnostic, since it is a stale literal rather than an intentional
  // {activity} customization.
  test("D6: the unedited old default profile migrates silently, with no diagnostic", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    tmux.setProfile("@1", "{activity}:{scope}/{task}");
    await runtime.handle(event("window_changed"));

    expect(tmux.get("@1").windowName).toBe("partjobs");
    const report = await runtime.explain({ windowId: "@1" });
    expect(report.displayDiagnostic).toBeUndefined();
  });

  // Characterization tests for #handleLocked (manual mode, dedup, rate-limit
  // blocking, debounce, refresh forcing) pinned before the STAGE 2 refactor
  // that splits it into #primeSnapshotState / #updateLocalRecord /
  // #decideTrigger / #scheduleOrRun. These must stay green across that
  // refactor with zero behaviour change.
  describe("characterization: manual mode, dedup, rate limits, debounce, refresh", () => {
    test("manual mode never triggers automatic inference, regardless of event kind", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      const model = new FakeModel();
      const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

      tmux.get("@1").windowName = "manual work";
      await runtime.handle(event("manual_name_changed", { manualName: "manual work" }));
      expect((await runtime.explain({ windowId: "@1" })).mode).toBe("manual");

      tmux.setPath("@1", "/home/jc/dev/partjobs/other-area");
      await runtime.handle(event("window_changed"));
      tmux.setContent("%1", "User: totally different task now");
      await runtime.handle(event("content_settled"));
      await runtime.handle(event("refresh_requested"));
      await clock.advance(1000);

      expect(model.calls).toHaveLength(0);
      expect(tmux.get("@1").windowName).toBe("manual work");
    });

    test("debounces automatic inference until the configured delay elapses", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      const model = new FakeModel();
      const cfg = config();
      cfg.limits.debounce_ms = 50;
      const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

      const outcome = await runtime.handle(event("content_settled"));
      expect(outcome.kind).toBe("scheduled");
      expect(model.calls).toHaveLength(0);

      await clock.advance(40);
      expect(model.calls).toHaveLength(0);

      await clock.advance(10);
      expect(model.calls).toHaveLength(1);
    });

    test("blocks an automatic retry within the minimum call interval", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      // Abstains so the Task never gets accepted (ADR 0001), keeping this
      // window eligible for further pre-acceptance automatic attempts.
      const model = new FakeModel(async () => abstainProposal());
      const cfg = config();
      cfg.limits.minimum_call_interval_ms = 5000;
      const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);

      tmux.setContent("%1", "User: investigate daemon resource usage");
      const outcome = await runtime.handle(event("content_settled"));

      expect(outcome).toEqual({
        kind: "ignored",
        windowId: "@1",
        reason: "minimum_interval",
      });
      expect(model.calls).toHaveLength(1);
      expect((await runtime.explain({ windowId: "@1" })).lastError).toBe("minimum_interval");
    });

    test("forced refresh bypasses the minimum call interval that blocks automatic retries", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      const model = new FakeModel();
      const cfg = config();
      cfg.limits.minimum_call_interval_ms = 5000;
      const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);

      const outcome = await runtime.handle(event("refresh_requested"));

      expect(outcome.kind).toBe("applied");
      expect(model.calls).toHaveLength(2);
    });

    test("blocks inference once the server-wide hourly quota is exhausted", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot({ windowId: "@1" }));
      tmux.add(
        windowSnapshot({
          windowId: "@2",
          sessionName: "proj2",
          sessionPath: "/tmp/proj2",
          panes: [
            {
              id: "%2",
              active: true,
              cwd: "/tmp/proj2",
              command: "zsh",
              pid: 200,
              title: "zsh",
            },
          ],
        }),
      );
      const clock = new FakeClock();
      const model = new FakeModel();
      const cfg = config();
      cfg.limits.max_calls_per_server_hour = 1;
      const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

      await runtime.handle(event("content_settled", { windowId: "@1" }));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);

      const outcome = await runtime.handle(event("content_settled", { windowId: "@2" }));
      await clock.advance(10);

      expect(outcome).toEqual({
        kind: "ignored",
        windowId: "@2",
        reason: "server_quota",
      });
      expect(model.calls).toHaveLength(1);
      expect((await runtime.explain({ windowId: "@2" })).lastError).toBe("server_quota");
    });

    test("blocks inference while the failure circuit is open, even for a forced refresh", async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      const model = new FakeModel(async () => {
        throw new Error("boom");
      });
      const cfg = config();
      cfg.limits.circuit_failure_threshold = 1;
      const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);
      expect(
        (await runtime.explain({ windowId: "@1" })).limits.circuitOpenUntil,
      ).toBeDefined();

      const outcome = await runtime.handle(event("refresh_requested"));

      expect(outcome).toEqual({
        kind: "ignored",
        windowId: "@1",
        reason: "circuit_open",
      });
      expect(model.calls).toHaveLength(1);
    });
  });
});

// Behaviour tests for ADR 0001 (docs/adr/0001-stable-window-work-labels.md)
// and ADR 0002's D1-D5 resolved questions.
describe("ADR-0001 target behaviour", () => {
  test("an accepted Task survives a Workspace/scope change with no automatic model call", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);
    const accepted = await runtime.explain({ windowId: "@1" });
    expect(accepted.accepted).toBe(true);

    tmux.setPath("@1", "/tmp/a-different-workspace", "/tmp/a-different-workspace");
    await runtime.handle(event("window_changed"));

    expect(model.calls).toHaveLength(1);
    const after = await runtime.explain({ windowId: "@1" });
    expect(after.record).toEqual(accepted.record);
  });

  test("an accepted Task survives a cwd change within the same Workspace with no automatic model call", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);
    const accepted = await runtime.explain({ windowId: "@1" });

    tmux.setPath("@1", "/home/jc/dev/partjobs/a-different-subdirectory");
    await runtime.handle(event("window_changed"));

    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).record).toEqual(accepted.record);
  });

  test("an accepted Task survives the foreground process exiting with no automatic model call", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);

    await runtime.handle({
      version: 1,
      source: "zsh",
      kind: "command_finished",
      windowId: "@1",
      commandName: "pytest",
      exitCode: 0,
    });
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
  });

  test("refresh keeps the old accepted Task when inference fails", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    const accepted = await runtime.explain({ windowId: "@1" });

    model.handler = async () => {
      throw new Error("boom");
    };
    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome.kind).toBe("failed");
    const after = await runtime.explain({ windowId: "@1" });
    expect(after.record).toEqual(accepted.record);
    expect(after.accepted).toBe(true);
    expect(after.badge.state).toBe("failed");
  });

  test("refresh keeps the old accepted Task when the model abstains", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    const accepted = await runtime.explain({ windowId: "@1" });

    model.handler = async () => abstainProposal();
    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome).toEqual({ kind: "ignored", windowId: "@1", reason: "abstained" });
    const after = await runtime.explain({ windowId: "@1" });
    expect(after.record).toEqual(accepted.record);
    expect(after.accepted).toBe(true);
    expect(after.badge.state).not.toBe("failed");
    expect(after.limits.windowCallsLastHour).toBe(2);
  });

  test("refresh replaces the accepted Task on a successful proposal", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe(
      "redesign-naming-plugin",
    );

    model.handler = async (request) => proposalFor(request, "finish the redesign");
    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome.kind).toBe("applied");
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe(
      "finish-the-redesign",
    );
  });

  test("'keep' on an empty Workspace-only fallback abstains rather than accepting nothing", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    await runtime.handle(event("window_changed"));
    expect((await runtime.explain({ windowId: "@1" })).accepted).toBe(false);

    // There is no previous Task to keep yet, only a Workspace-only fallback
    // (empty task), so "keep" has nothing to confirm and must abstain (D5).
    model.handler = async () => keepProposal();
    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome).toEqual({ kind: "ignored", windowId: "@1", reason: "abstained" });
    expect((await runtime.explain({ windowId: "@1" })).accepted).toBe(false);
  });

  test("refresh can accept a pre-existing (not-yet-accepted) Task for the first time via 'keep'", async () => {
    // Simulates a window whose persisted state predates the `accepted`
    // field (an upgrade from before ADR 0001): it already carries a real
    // AI-provenance Task, but loads as `accepted: false`. A "keep" refresh
    // is how such a Task is confirmed into the new accepted lifecycle.
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        windowName: "partjobs/legacy-task",
        persisted: {
          version: 2,
          mode: "automatic",
          revision: 2,
          record: { scope: { workspace: "partjobs" }, task: "legacy-task" },
          provenance: "ai",
          lastAppliedName: "partjobs/legacy-task",
        },
      }),
    );
    const model = new FakeModel(async () => keepProposal());
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    expect((await runtime.explain({ windowId: "@1" })).accepted).toBe(false);

    const outcome = await runtime.handle(event("refresh_requested"));

    expect(outcome.kind).toBe("applied");
    const report = await runtime.explain({ windowId: "@1" });
    expect(report.accepted).toBe(true);
    expect(report.record?.task).toBe("legacy-task");

    // Now genuinely accepted: further automatic evidence must not replace it.
    tmux.setPath("@1", "/tmp/somewhere-else", "/tmp/somewhere-else");
    await runtime.handle(event("window_changed"));
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe("legacy-task");
  });

  test("'keep' is only meaningful on refresh; a non-refresh trigger never accepts via 'keep' (D5)", async () => {
    // Same pre-existing, not-yet-accepted legacy Task as above, but this
    // time an ordinary automatic trigger (not `refresh`) is what reaches
    // the model with a "keep" outcome. D5 says "keep" is only meaningful
    // on refresh, so this must abstain rather than silently accepting the
    // legacy Task outside of an explicit user request.
    const tmux = new FakeTmux();
    tmux.add(
      windowSnapshot({
        windowName: "partjobs/legacy-task",
        persisted: {
          version: 2,
          mode: "automatic",
          revision: 2,
          record: { scope: { workspace: "partjobs" }, task: "legacy-task" },
          provenance: "ai",
          lastAppliedName: "partjobs/legacy-task",
        },
      }),
    );
    const clock = new FakeClock();
    const model = new FakeModel(async () => keepProposal());
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    const outcome = await runtime.handle(event("content_settled"));
    await clock.advance(10);

    expect(outcome).toEqual({ kind: "scheduled", windowId: "@1" });
    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).accepted).toBe(false);
  });

  test(
    "'new' discards the accepted Task, shows the Workspace-only name, and waits for changed evidence before inferring again",
    async () => {
      const tmux = new FakeTmux();
      tmux.add(windowSnapshot());
      const clock = new FakeClock();
      const model = new FakeModel();
      const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);

      const outcome = await runtime.handle(event("new_work_requested"));
      expect(outcome).toEqual({ kind: "applied", windowId: "@1", name: "partjobs" });
      const afterNew = await runtime.explain({ windowId: "@1" });
      expect(afterNew.accepted).toBe(false);
      expect(afterNew.record).toEqual({
        scope: { workspace: "partjobs" },
        task: "",
      });

      // D1: residual (unchanged) evidence must not retrigger inference.
      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(1);

      // Changed, settled evidence is eligible again.
      tmux.setContent("%1", "User: start a brand new task");
      await runtime.handle(event("content_settled"));
      await clock.advance(10);
      expect(model.calls).toHaveLength(2);
    },
  );

  test("'new' does not reset quotas or affect other windows", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot({ windowId: "@1" }));
    tmux.add(
      windowSnapshot({
        windowId: "@2",
        sessionName: "proj2",
        sessionPath: "/tmp/proj2",
        panes: [{ ...windowSnapshot().panes[0]!, id: "%2" }],
      }),
    );
    const clock = new FakeClock();
    const cfg = config();
    cfg.limits.max_calls_per_window_hour = 1;
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: cfg });

    await runtime.handle(event("content_settled", { windowId: "@1" }));
    await clock.advance(10);
    expect((await runtime.explain({ windowId: "@1" })).limits.windowCallsLastHour).toBe(1);

    await runtime.handle(event("new_work_requested", { windowId: "@1" }));
    expect((await runtime.explain({ windowId: "@1" })).limits.windowCallsLastHour).toBe(1);
    expect((await runtime.explain({ windowId: "@2" })).accepted).toBe(false);
    expect((await runtime.explain({ windowId: "@2" })).mode).toBe("automatic");
  });

  test("manual mode refuses 'new' and asks the user to restore automation first", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, config: config() });

    tmux.get("@1").windowName = "manual work";
    await runtime.handle(event("manual_name_changed", { manualName: "manual work" }));
    expect((await runtime.explain({ windowId: "@1" })).mode).toBe("manual");

    const outcome = await runtime.handle(event("new_work_requested"));

    expect(outcome).toEqual({ kind: "ignored", windowId: "@1", reason: "manual_mode" });
    expect((await runtime.explain({ windowId: "@1" })).manualName).toBe("manual work");
    expect(model.calls).toHaveLength(0);
  });

  test("'new' on a hidden window baselines evidence without reading its pane text (D2/D4)", async () => {
    // Unlike `refresh`, `new` is not listed as consent to read a hidden
    // pane's text (D4 names only `refresh`); its D1 baseline must follow
    // the same visibility rule as every other automatic evidence read, so
    // that baseline stays consistent with later automatic attempts, which
    // also see an empty terminal context while the window stays hidden.
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    tmux.hide("%1");
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);

    await runtime.handle(event("new_work_requested"));

    // D1: residual (unchanged, still-hidden) evidence must not retrigger
    // inference just because the window remains hidden.
    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);
  });

  test("after Task acceptance, no further automatic model calls occur regardless of trigger", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);

    tmux.setPath("@1", "/tmp/somewhere-else", "/tmp/somewhere-else");
    await runtime.handle(event("window_changed"));
    tmux.setContent("%1", "User: totally different work now");
    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    await runtime.handle({
      version: 1,
      source: "zsh",
      kind: "command_finished",
      windowId: "@1",
      commandName: "pytest",
      exitCode: 0,
    });
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
  });

  test("automatic (non-refresh) triggers never read a hidden window's pane text (D2/D4)", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    tmux.hide("%1");
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.terminalContext).toBe("");

    // An explicit refresh counts as consent to read that one pane (D4).
    const outcome = await runtime.handle(event("refresh_requested"));
    expect(outcome.kind).toBe("applied");
    expect(model.calls[1]?.terminalContext).toContain("redesign the tmux window naming plugin");
  });
});

describe("ADR-0002 normal outcomes", () => {
  test("missing AI configuration is a normal outcome, not a failed badge", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const runtime = new AutonameRuntime({ tmux, clock, config: config() });

    const outcome = await runtime.handle(event("content_settled"));
    await clock.advance(10);

    expect(outcome).toEqual({
      kind: "ignored",
      windowId: "@1",
      reason: "model_not_configured",
    });
    const report = await runtime.explain({ windowId: "@1" });
    expect(report.badge.state).not.toBe("failed");
    expect(report.lastError).toBe("model_not_configured");
  });

  test("an auth failure pauses further automatic attempts until a successful refresh", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel(async () => {
      throw new ProviderAuthenticationError();
    });
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);
    expect((await runtime.explain({ windowId: "@1" })).badge.state).toBe("secret_unavailable");

    // A further automatic trigger is paused, not just deduplicated: change
    // the evidence so it would otherwise be eligible.
    tmux.setPath("@1", "/tmp/paused-workspace-1", "/tmp/paused-workspace-1");
    const blocked = await runtime.handle(event("window_changed"));
    expect(blocked).toEqual({
      kind: "ignored",
      windowId: "@1",
      reason: "provider_authentication_failed",
    });
    expect(model.calls).toHaveLength(1);

    // An explicit refresh is allowed through even while paused; a refresh
    // that fails again does not lift the pause.
    const stillFailing = await runtime.handle(event("refresh_requested"));
    expect(stillFailing.kind).toBe("failed");
    expect(model.calls).toHaveLength(2);
    tmux.setPath("@1", "/tmp/paused-workspace-2", "/tmp/paused-workspace-2");
    const stillBlocked = await runtime.handle(event("window_changed"));
    expect(stillBlocked).toEqual({
      kind: "ignored",
      windowId: "@1",
      reason: "provider_authentication_failed",
    });
    expect(model.calls).toHaveLength(2);

    // A successful refresh (any resolved outcome, including abstention)
    // lifts the pause going forward.
    model.handler = async () => abstainProposal();
    const succeeded = await runtime.handle(event("refresh_requested"));
    expect(succeeded).toEqual({ kind: "ignored", windowId: "@1", reason: "abstained" });
    expect(model.calls).toHaveLength(3);

    tmux.setContent("%1", "User: automatic attempts resume");
    const resumed = await runtime.handle(event("content_settled"));
    expect(resumed).toEqual({ kind: "scheduled", windowId: "@1" });
    await clock.advance(10);
    expect(model.calls).toHaveLength(4);
  });

  test("secrets reload also lifts the auth pause", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot());
    const clock = new FakeClock();
    const model = new FakeModel(async () => {
      throw new SecretUnavailableError();
    });
    const runtime = new AutonameRuntime({ tmux, model, clock, config: config() });

    await runtime.handle(event("content_settled"));
    await clock.advance(10);
    expect(model.calls).toHaveLength(1);

    await runtime.resetFailures();
    model.handler = async (request) => proposalFor(request);
    tmux.setContent("%1", "User: recovered after reload");
    const outcome = await runtime.handle(event("content_settled"));
    expect(outcome).toEqual({ kind: "scheduled", windowId: "@1" });
    await clock.advance(10);

    expect(model.calls).toHaveLength(2);
    expect((await runtime.explain({ windowId: "@1" })).record?.task).toBe(
      "redesign-naming-plugin",
    );
  });
});

describe("domain rules", () => {
  test("builds a grounded Workspace candidate list, most-preferred first", () => {
    const candidates = buildScopeCandidates(windowSnapshot());
    expect(candidates[0]?.value).toBe("partjobs");
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
    expect(candidates[0]?.value).toBe("tmux-autoname");
    expect(candidates.map((candidate) => candidate.value)).not.toContain("jc");
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

    // ADR 0003: the nested git root within the session Workspace no longer
    // produces a separate Area candidate -- only the session Workspace.
    expect(candidates[0]?.value).toBe("partjobs");
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

  test("uses supporting panes, remote hosts, and common ancestors as Workspace candidates", () => {
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

    const workspaceValues = candidates.map((candidate) => candidate.value);
    expect(workspaceValues).toContain("build.example.com");
    expect(workspaceValues).toContain("beta");
    expect(workspaceValues).toContain("partjobs");
    expect(candidates.some((candidate) => candidate.facts.includes("supporting pane cwd")))
      .toBe(true);
  });

  test("renders full names and leaves truncation to tmux", () => {
    expect(
      renderName({
        scope: { workspace: "partjobs" },
        task: "rewrite-patent-draft",
      }),
    ).toBe("partjobs/rewrite-patent-draft");
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
