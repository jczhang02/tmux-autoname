#!/usr/bin/env bun
import { TmuxCliPort } from "./adapters";
import { semanticEventSchema, type SemanticEvent } from "./domain";
import {
  daemonRequest,
  logDiagnostic,
  runDaemon,
  runtimePaths,
  startDaemon,
  type DaemonRequest,
} from "./daemon";

const args = process.argv.slice(2);
const command = args[0];

const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const targetEvent = (
  kind: SemanticEvent["kind"],
  extra: Partial<SemanticEvent> = {},
): SemanticEvent =>
  semanticEventSchema.parse({
    version: 1,
    source: "cli",
    kind,
    ...(flag("--window") ? { windowId: flag("--window") } : {}),
    ...(flag("--pane") || process.env.TMUX_PANE
      ? { paneId: flag("--pane") ?? process.env.TMUX_PANE }
      : {}),
    ...extra,
  });

const tmux = (): TmuxCliPort => TmuxCliPort.fromEnvironment();

const requestWithStart = async (
  port: TmuxCliPort,
  request: DaemonRequest,
  timeoutMs = 1500,
) => {
  const paths = runtimePaths(port.serverId);
  try {
    return await daemonRequest(paths.socket, request, timeoutMs);
  } catch {
    await startDaemon(port);
    return daemonRequest(paths.socket, request, timeoutMs);
  }
};

const parseEmitEvent = async (): Promise<SemanticEvent> => {
  let input: Record<string, unknown> = {};
  if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text();
    if (text.trim()) input = JSON.parse(text) as Record<string, unknown>;
  }
  const source = (input.source as string | undefined) ?? flag("--source");
  const kind = (input.kind as string | undefined) ?? flag("--kind");
  const event = semanticEventSchema.parse({
    version: 1,
    ...input,
    source,
    kind,
    ...(flag("--window") ? { windowId: flag("--window") } : {}),
    ...(flag("--pane") || process.env.TMUX_PANE
      ? { paneId: flag("--pane") ?? process.env.TMUX_PANE }
      : {}),
    ...(flag("--command-name") ? { commandName: flag("--command-name") } : {}),
    ...(flag("--exit-code") ? { exitCode: Number.parseInt(flag("--exit-code")!, 10) } : {}),
  });
  return event;
};

const explicitTarget = (): { windowId?: string; paneId?: string } => ({
  ...(flag("--window") ? { windowId: flag("--window") } : {}),
  ...(flag("--pane") || process.env.TMUX_PANE
    ? { paneId: flag("--pane") ?? process.env.TMUX_PANE }
    : {}),
});

const main = async (): Promise<number> => {
  switch (command) {
    case "daemon": {
      const port = tmux();
      if (args.includes("--run")) await runDaemon(port);
      else if (args.includes("--stop")) {
        await daemonRequest(runtimePaths(port.serverId).socket, { type: "shutdown" }, 500).catch(
          () => undefined,
        );
      } else await startDaemon(port);
      return 0;
    }
    case "emit": {
      try {
        const event = await parseEmitEvent();
        const port = tmux();
        const response = await requestWithStart(port, { type: "event", event }, 500);
        if (!response.ok) await logDiagnostic(runtimePaths(port.serverId).log, response.error);
      } catch {
        try {
          const port = tmux();
          await logDiagnostic(runtimePaths(port.serverId).log, "emit_failed");
        } catch {}
      }
      return 0;
    }
    case "refresh": {
      const port = tmux();
      const event = targetEvent("refresh_requested");
      const response = await requestWithStart(port, { type: "event", event, wait: true });
      if (!response.ok) throw new Error(response.error);
      return 0;
    }
    case "auto": {
      const port = tmux();
      const event = targetEvent("manual_name_changed", { manualName: "" });
      const response = await requestWithStart(port, { type: "event", event, wait: true });
      if (!response.ok) throw new Error(response.error);
      return 0;
    }
    case "explain": {
      const port = tmux();
      const response = await requestWithStart(port, { type: "explain", ...explicitTarget() });
      if (!response.ok) throw new Error(response.error);
      process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
      return 0;
    }
    case "secrets": {
      if (args[1] !== "reload") throw new Error("usage: tmux-autoname secrets reload");
      const port = tmux();
      const response = await requestWithStart(port, { type: "shutdown" });
      if (!response.ok) throw new Error(response.error);
      await Bun.sleep(100);
      await startDaemon(port);
      return 0;
    }
    default:
      process.stderr.write(
        "usage: tmux-autoname <daemon|emit|refresh|auto|explain|secrets reload>\n",
      );
      return 2;
  }
};

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "tmux-autoname failed"}\n`);
  process.exitCode = 1;
}
