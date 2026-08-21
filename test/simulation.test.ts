import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { AutonameRuntime } from "../src/runtime";
import { FakeClock, FakeModel, FakeTmux, proposalFor, windowSnapshot } from "./helpers";

const simulationConfig = () => {
  const config = defaultConfig();
  config.limits.debounce_ms = 0;
  config.limits.minimum_call_interval_ms = 0;
  config.limits.request_timeout_ms = 1000;
  return config;
};

const changed = (windowId: string) => ({
  version: 1 as const,
  source: "test" as const,
  kind: "window_changed" as const,
  windowId,
});

const mixedEvent = (windowId: string, index: number) => {
  switch (index % 3) {
    case 0:
      return {
        version: 1 as const,
        source: "tmux" as const,
        kind: "content_settled" as const,
        windowId,
      };
    case 1:
      return {
        version: 1 as const,
        source: "zsh" as const,
        kind: "command_finished" as const,
        windowId,
        commandName: "pytest",
        exitCode: 0,
      };
    default:
      return changed(windowId);
  }
};

describe("accelerated logical-time simulation", () => {
  test("enforces six automatic calls per window across 24 logical hours", async () => {
    const tmux = new FakeTmux();
    tmux.add(windowSnapshot({ windowId: "@1", panes: [windowSnapshot().panes[0]!] }));
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: simulationConfig() });

    await runtime.handle(changed("@1"));
    for (let hour = 0; hour < 24; hour += 1) {
      if (hour > 0) await clock.advance(60 * 60 * 1000);
      for (let eventIndex = 0; eventIndex < 8; eventIndex += 1) {
        tmux.setPath(
          "@1",
          `/home/jc/dev/partjobs/project-${hour}-${eventIndex}`,
          `/home/jc/dev/partjobs/project-${hour}-${eventIndex}`,
        );
        tmux.setContent("%1", `logical hour ${hour} task ${eventIndex}`);
        await runtime.handle(mixedEvent("@1", eventIndex));
        await clock.advance(0);
      }
    }

    expect(model.calls).toHaveLength(24 * 6);
    expect(clock.timerCount).toBe(0);
    await clock.advance(60 * 60 * 1000);
    expect((await runtime.explain({ windowId: "@1" })).limits.windowCallsLastHour).toBe(0);
  });

  test("enforces thirty automatic calls per tmux server", async () => {
    const tmux = new FakeTmux();
    const clock = new FakeClock();
    const model = new FakeModel();
    const runtime = new AutonameRuntime({ tmux, model, clock, config: simulationConfig() });

    for (let index = 1; index <= 31; index += 1) {
      const windowId = `@${index}`;
      const pane = { ...windowSnapshot().panes[0]!, id: `%${index}` };
      tmux.add(windowSnapshot({ windowId, panes: [pane] }));
      await runtime.handle(changed(windowId));
      tmux.setPath(windowId, `/home/jc/dev/partjobs/project-${index}`);
      await runtime.handle(changed(windowId));
      await clock.advance(0);
    }

    expect(model.calls).toHaveLength(30);
    expect(
      (await runtime.explain({ windowId: "@31" })).limits.serverCallsLastHour,
    ).toBe(30);
    expect(clock.timerCount).toBe(0);
  });

  test("opens after three failures and recovers after ten logical minutes", async () => {
    const tmux = new FakeTmux();
    const clock = new FakeClock();
    let attempts = 0;
    const model = new FakeModel(async (request) => {
      attempts += 1;
      if (attempts <= 3) throw new Error("provider down");
      return proposalFor(request, "recover naming service");
    });
    const runtime = new AutonameRuntime({ tmux, model, clock, config: simulationConfig() });

    for (let index = 1; index <= 5; index += 1) {
      const windowId = `@${index}`;
      tmux.add(
        windowSnapshot({
          windowId,
          panes: [{ ...windowSnapshot().panes[0]!, id: `%${index}` }],
        }),
      );
      await runtime.handle(changed(windowId));
    }

    for (let index = 1; index <= 3; index += 1) {
      tmux.setPath(`@${index}`, `/home/jc/dev/partjobs/failure-${index}`);
      await runtime.handle(changed(`@${index}`));
      await clock.advance(0);
    }
    tmux.setPath("@4", "/home/jc/dev/partjobs/circuit-blocked");
    await runtime.handle(changed("@4"));
    await clock.advance(0);
    expect(model.calls).toHaveLength(3);
    expect((await runtime.explain({ windowId: "@4" })).limits.circuitOpenUntil).toBe(
      10 * 60 * 1000,
    );

    const restartedModel = new FakeModel((request) =>
      Promise.resolve(proposalFor(request, "recover naming service"))
    );
    const restarted = new AutonameRuntime({
      tmux,
      model: restartedModel,
      clock,
      config: simulationConfig(),
    });
    await restarted.explain({ windowId: "@4" });
    await restarted.explain({ windowId: "@5" });
    tmux.setPath("@4", "/home/jc/dev/partjobs/restart-still-blocked");
    await restarted.handle(changed("@4"));
    await clock.advance(0);
    expect(restartedModel.calls).toHaveLength(0);

    await clock.advance(10 * 60 * 1000);
    tmux.setPath("@5", "/home/jc/dev/partjobs/recovered");
    await restarted.handle(changed("@5"));
    await clock.advance(0);

    expect(model.calls).toHaveLength(3);
    expect(restartedModel.calls).toHaveLength(1);
    expect(tmux.get("@5").windowName).toEndWith("/recover naming service");
    expect(clock.timerCount).toBe(0);
  });
});
