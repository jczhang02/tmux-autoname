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
import type { ExplainReport, RuntimeOutcome } from "./runtime";

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
const jsonOutput = (): boolean => args.includes("--json");

const reasonText = (reason: string | undefined): string => ({
  circuit_open: "AI circuit is open; reload credentials or wait for cooldown",
  window_quota: "window AI quota reached",
  server_quota: "server AI quota reached",
  minimum_interval: "waiting for the minimum AI call interval",
  model_not_configured: "AI is not configured",
  provider_authentication_failed: "provider rejected the credential; automatic attempts are paused until refresh or secrets reload",
  secret_unavailable: "credential is unavailable; automatic attempts are paused until refresh or secrets reload",
  model_timeout: "provider request timed out",
  invalid_model_response: "provider returned invalid JSON",
  evidence_changed: "pane evidence changed while AI was running",
  superseded: "a newer naming request replaced this one",
  abstained: "AI had insufficient evidence and abstained; the previous name is kept",
  manual_mode: "automatic naming is off; run `tmux-autoname auto` first",
  no_trigger: "no change in evidence justifies a new request",
  deduplicated: "evidence is unchanged since the last attempt",
}[reason ?? ""] ?? reason ?? "no change");

const formatExplain = (report: ExplainReport): string => {
  const scope = report.record?.scope.area
    ? `${report.record.scope.workspace}/${report.record.scope.area}`
    : report.record?.scope.workspace ?? "(pending)";
  const status = report.lastError
    ? reasonText(report.lastError)
    : report.badge.state === "generating" ? "generating" : "ready";
  return [
    `${report.windowId} ${report.mode}`,
    `Name: ${report.visibleName}`,
    `Activity: ${report.record?.activity ?? "(pending)"}`,
    `Scope: ${scope}`,
    `Task: ${report.record?.task || "(pending AI)"}`,
    `Source: ${report.provenance === "ai" ? "AI" : "local provisional"}`,
    `Accepted: ${report.accepted ? "yes" : "no"}`,
    `Calls: window ${report.limits.windowCallsLastHour}/${report.limits.windowCallLimit}, server ${report.limits.serverCallsLastHour}/${report.limits.serverCallLimit}`,
    `Status: ${status}`,
  ].join("\n");
};

const formatOutcome = (outcome: RuntimeOutcome, report: ExplainReport): string => {
  if (outcome.kind === "applied") return `${outcome.windowId} renamed → ${outcome.name ?? report.visibleName}`;
  if (outcome.kind === "manual") return `${outcome.windowId} kept manual name → ${report.visibleName}`;
  return `${outcome.windowId} unchanged → ${report.visibleName} (${reasonText(outcome.reason)})`;
};

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
    ...(flag("--manual-name") !== undefined ? { manualName: flag("--manual-name") } : {}),
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
      let response = await requestWithStart(port, { type: "event", event, wait: true }, 30_000);
      if (!response.ok) throw new Error(response.error);
      let outcome = response.result as RuntimeOutcome | undefined;
      if (outcome?.kind === "ignored" && ["evidence_changed", "superseded"].includes(outcome.reason ?? "")) {
        response = await requestWithStart(port, { type: "event", event, wait: true }, 30_000);
        if (!response.ok) throw new Error(response.error);
        outcome = response.result as RuntimeOutcome | undefined;
      }
      const explained = await requestWithStart(port, { type: "explain", ...explicitTarget() });
      if (!explained.ok || !outcome) throw new Error(explained.ok ? "missing_result" : explained.error);
      const report = explained.result as ExplainReport;
      process.stdout.write(
        jsonOutput()
          ? `${JSON.stringify({ outcome, report }, null, 2)}\n`
          : `${formatOutcome(outcome, report)}\n`,
      );
      return 0;
    }
    case "auto": {
      const port = tmux();
      const event = targetEvent("manual_name_changed", { manualName: "" });
      const response = await requestWithStart(port, { type: "event", event, wait: true });
      if (!response.ok) throw new Error(response.error);
      const outcome = response.result as RuntimeOutcome | undefined;
      if (outcome) process.stdout.write(`${outcome.windowId} automatic → ${outcome.name ?? "ready"}\n`);
      return 0;
    }
    case "new": {
      const port = tmux();
      const event = targetEvent("new_work_requested");
      const response = await requestWithStart(port, { type: "event", event, wait: true });
      if (!response.ok) throw new Error(response.error);
      const outcome = response.result as RuntimeOutcome | undefined;
      if (outcome?.kind === "ignored" && outcome.reason === "manual_mode") {
        process.stderr.write(`${outcome.windowId} ${reasonText(outcome.reason)}\n`);
        return 1;
      }
      if (outcome) process.stdout.write(`${outcome.windowId} new work → ${outcome.name ?? "ready"}\n`);
      return 0;
    }
    case "explain": {
      const port = tmux();
      const response = await requestWithStart(port, { type: "explain", ...explicitTarget() });
      if (!response.ok) throw new Error(response.error);
      const report = response.result as ExplainReport;
      process.stdout.write(
        jsonOutput() ? `${JSON.stringify(report, null, 2)}\n` : `${formatExplain(report)}\n`,
      );
      return 0;
    }
    case "secrets": {
      if (args[1] !== "reload") throw new Error("usage: tmux-autoname secrets reload");
      const port = tmux();
      const response = await requestWithStart(port, { type: "shutdown", resetFailures: true });
      if (!response.ok) throw new Error(response.error);
      const socket = runtimePaths(port.serverId).socket;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await Bun.sleep(25);
        const running = await daemonRequest(socket, { type: "ping" }, 50).catch(() => undefined);
        if (!running?.ok) break;
      }
      await startDaemon(port);
      process.stdout.write("Credentials reloaded; daemon restarted.\n");
      return 0;
    }
    default:
      process.stderr.write(
        "usage:\n  tmux-autoname refresh [--window @N|--pane %N] [--json]\n  tmux-autoname new [--window @N|--pane %N]\n  tmux-autoname explain [--window @N|--pane %N] [--json]\n  tmux-autoname auto [--window @N|--pane %N]\n  tmux-autoname secrets reload\n  tmux-autoname daemon [--stop]\n",
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
