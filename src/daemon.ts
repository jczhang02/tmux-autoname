import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { AiSdkModel, TmuxCliPort } from "./adapters";
import { type AppConfig, loadConfig } from "./config";
import { semanticEventSchema, type SemanticEvent } from "./domain";
import { AutonameRuntime, type ExplainReport, type RuntimeOutcome } from "./runtime";

const MAX_MESSAGE_BYTES = 16 * 1024;
const LOG_LIMIT_BYTES = 64 * 1024;
export const DAEMON_BUILD = "0.4.1";

export type RuntimePaths = {
  directory: string;
  socket: string;
  log: string;
  pid: string;
  startupLock: string;
};

export type DaemonRequest =
  | { type: "ping" }
  | { type: "event"; event: SemanticEvent; wait?: boolean }
  | { type: "explain"; windowId?: string; paneId?: string }
  | { type: "shutdown"; resetFailures?: boolean };

export type DaemonResponse =
  | { ok: true; build?: string; result?: RuntimeOutcome | ExplainReport }
  | { ok: false; error: string };

type ContentObservation = { digest: string; changedAt: number; emitted: boolean };

export class ContentMonitor {
  readonly #tmux: Pick<TmuxCliPort, "activePanes" | "paneSignals" | "capturePane">;
  readonly #settleMs: number;
  readonly #onChanged: ((paneId: string) => Promise<RuntimeOutcome>) | undefined;
  readonly #onSettled: ((paneId: string) => Promise<RuntimeOutcome>) | undefined;
  readonly #observations = new Map<string, ContentObservation>();
  readonly #paneSignals = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #scanning = false;

  constructor(options: {
    tmux: Pick<TmuxCliPort, "activePanes" | "paneSignals" | "capturePane">;
    settleMs: number;
    onChanged?: (paneId: string) => Promise<RuntimeOutcome>;
    onSettled?: (paneId: string) => Promise<RuntimeOutcome>;
  }) {
    this.#tmux = options.tmux;
    this.#settleMs = options.settleMs;
    this.#onChanged = options.onChanged;
    this.#onSettled = options.onSettled;
  }

  start(intervalMs: number): void {
    if (this.#timer) return;
    void this.scan();
    this.#timer = setInterval(() => void this.scan(), intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#observations.clear();
    this.#paneSignals.clear();
  }

  async scan(now = Date.now()): Promise<void> {
    if (this.#scanning) return;
    this.#scanning = true;
    try {
      const signals = await this.#tmux.paneSignals();
      const livePanes = new Set(signals.map((signal) => signal.paneId));
      for (const signal of signals) {
        if (this.#paneSignals.get(signal.paneId) === signal.signature) continue;
        this.#paneSignals.set(signal.paneId, signal.signature);
        await this.#onChanged?.(signal.paneId).catch(() => undefined);
      }
      for (const paneId of this.#paneSignals.keys()) {
        if (!livePanes.has(paneId)) this.#paneSignals.delete(paneId);
      }
      if (!this.#onSettled) return;

      const active = new Set(await this.#tmux.activePanes());
      for (const paneId of active) {
        const content = await this.#tmux.capturePane(paneId).catch(() => "");
        if (!content) {
          this.#observations.delete(paneId);
          continue;
        }
        const digest = createHash("sha256").update(content).digest("base64url");
        const previous = this.#observations.get(paneId);
        if (!previous || previous.digest !== digest) {
          this.#observations.set(paneId, { digest, changedAt: now, emitted: false });
          continue;
        }
        if (previous.emitted || now - previous.changedAt < this.#settleMs) continue;
        previous.emitted = true;
        const outcome = await this.#onSettled(paneId).catch(() => undefined);
        if (outcome?.reason === "minimum_interval") previous.emitted = false;
      }
      for (const paneId of this.#observations.keys()) {
        if (!active.has(paneId)) this.#observations.delete(paneId);
      }
    } finally {
      this.#scanning = false;
    }
  }
}

export const runtimePaths = (
  serverId: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePaths => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = env.XDG_RUNTIME_DIR ?? join(tmpdir(), `tmux-autoname-${uid}`);
  const directory = join(base, "tmux-autoname");
  return {
    directory,
    socket: join(directory, `${serverId}.sock`),
    log: join(directory, `${serverId}.log`),
    pid: join(directory, `${serverId}.pid`),
    startupLock: join(directory, `${serverId}.start`),
  };
};

export const startDaemon = async (tmux: TmuxCliPort): Promise<void> => {
  const paths = runtimePaths(tmux.serverId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  let running = await daemonRequest(paths.socket, { type: "ping" }, 500).catch(
    () => undefined,
  );
  if (running?.ok && running.build === DAEMON_BUILD) return;

  const startupLock = await acquireStartupLock(paths.startupLock);
  if (!startupLock) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await Bun.sleep(100);
      const response = await daemonRequest(paths.socket, { type: "ping" }, 100).catch(
        () => undefined,
      );
      if (response?.ok && response.build === DAEMON_BUILD) return;
    }
    throw new Error(`daemon_starting; see ${paths.log}`);
  }

  try {
    running = await daemonRequest(paths.socket, { type: "ping" }, 500).catch(
      () => undefined,
    );
    if (!running?.ok && await daemonPidAlive(paths.pid)) {
      for (let attempt = 0; attempt < 5 && !running?.ok; attempt += 1) {
        await Bun.sleep(100);
        running = await daemonRequest(paths.socket, { type: "ping" }, 500).catch(
          () => undefined,
        );
      }
      if (!running?.ok && await daemonPidAlive(paths.pid)) {
        throw new Error(`daemon_unresponsive; see ${paths.log}`);
      }
    }
    if (running?.ok && running.build === DAEMON_BUILD) return;
    if (running?.ok) {
      await daemonRequest(paths.socket, { type: "shutdown" }, 500).catch(() => undefined);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Bun.sleep(25);
        const stale = await daemonRequest(paths.socket, { type: "ping" }, 50).catch(
          () => undefined,
        );
        if (!stale?.ok) break;
        if (attempt === 19) throw new Error(`stale_daemon; see ${paths.log}`);
      }
    }

    const entry = process.argv[1];
    const command = entry && /\.[cm]?[jt]s$/u.test(entry)
      ? [process.execPath, entry, "daemon", "--run"]
      : [process.execPath, "daemon", "--run"];
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        TMUX_AUTONAME_TMUX_SOCKET: tmux.socketPath,
      },
    });
    child.unref();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(50);
      const response = await daemonRequest(paths.socket, { type: "ping" }, 100).catch(
        () => undefined,
      );
      if (response?.ok && response.build === DAEMON_BUILD) return;
    }
    await logDiagnostic(paths.log, "daemon_start_failed");
    throw new Error(`daemon_start_failed; see ${paths.log}`);
  } finally {
    await startupLock.close().catch(() => undefined);
    await unlink(paths.startupLock).catch(() => undefined);
  }
};

export const runDaemon = async (tmux: TmuxCliPort): Promise<void> => {
  const paths = runtimePaths(tmux.serverId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);

  if (await daemonRequest(paths.socket, { type: "ping" }, 150).catch(() => undefined)) {
    return;
  }
  if (await daemonPidAlive(paths.pid)) return;
  await unlink(paths.socket).catch(() => undefined);

  let config: AppConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    await logDiagnostic(paths.log, describeConfigError(error));
    throw error;
  }

  let runtime: AutonameRuntime;
  try {
    runtime = new AutonameRuntime({
      tmux,
      config,
      onDiagnostic: (code) => void logDiagnostic(paths.log, code),
      ...(config.ai ? { model: new AiSdkModel(config.ai) } : {}),
    });
  } catch (error) {
    await logDiagnostic(
      paths.log,
      `runtime_construction_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  const monitor = new ContentMonitor({
    tmux,
    settleMs: config.limits.content_settle_ms,
    onChanged: (paneId) =>
      runtime.handle({ version: 1, source: "tmux", kind: "window_changed", paneId }),
    ...(config.ai
      ? {
          onSettled: (paneId: string) =>
            runtime.handle({ version: 1, source: "tmux", kind: "content_settled", paneId }),
        }
      : {}),
  });
  monitor.start(config.limits.scan_interval_ms);
  const buffers = new WeakMap<object, string>();

  const listener = Bun.listen<{ handled: boolean }>({
    unix: paths.socket,
    socket: {
      open(socket) {
        socket.data = { handled: false };
        buffers.set(socket, "");
      },
      data(socket, data) {
        if (socket.data.handled) return;
        const next = (buffers.get(socket) ?? "") + data.toString();
        if (Buffer.byteLength(next) > MAX_MESSAGE_BYTES) {
          socket.data.handled = true;
          socket.write(`${JSON.stringify({ ok: false, error: "message_too_large" })}\n`);
          socket.end();
          return;
        }
        const newline = next.indexOf("\n");
        if (newline < 0) {
          buffers.set(socket, next);
          return;
        }
        socket.data.handled = true;
        void handleLine(runtime, next.slice(0, newline))
          .then((response) => socket.write(`${JSON.stringify(response)}\n`))
          .catch(() => socket.write(`${JSON.stringify({ ok: false, error: "internal" })}\n`))
          .finally(() => socket.end());
      },
      close(socket) {
        buffers.delete(socket);
      },
      error() {},
    },
  });
  await chmod(paths.socket, 0o600);
  await Bun.write(paths.pid, `${process.pid}\n`);
  await chmod(paths.pid, 0o600);
  await logDiagnostic(paths.log, "daemon_started");

  const stop = async () => {
    monitor.stop();
    runtime.shutdown();
    listener.stop(true);
    await unlink(paths.socket).catch(() => undefined);
    await unlink(paths.pid).catch(() => undefined);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
};

const daemonPidAlive = async (path: string): Promise<boolean> => {
  const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireStartupLock = async (path: string) => {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(path).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs < 10_000) return undefined;
    await unlink(path).catch(() => undefined);
    return open(path, "wx", 0o600).catch(() => undefined);
  }
};

const handleLine = async (
  runtime: AutonameRuntime,
  line: string,
): Promise<DaemonResponse> => {
  let request: DaemonRequest;
  try {
    request = JSON.parse(line) as DaemonRequest;
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  try {
    switch (request.type) {
      case "ping":
        return { ok: true, build: DAEMON_BUILD };
      case "event": {
        const event = semanticEventSchema.parse(request.event);
        if (request.wait) return { ok: true, result: await runtime.handle(event) };
        void runtime.handle(event);
        return { ok: true };
      }
      case "explain":
        return {
          ok: true,
          result: await runtime.explain({
            ...(request.windowId ? { windowId: request.windowId } : {}),
            ...(request.paneId ? { paneId: request.paneId } : {}),
          }),
        };
      case "shutdown":
        if (request.resetFailures) await runtime.resetFailures();
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
        return { ok: true };
      default:
        return { ok: false, error: "unknown_request" };
    }
  } catch {
    return { ok: false, error: "request_failed" };
  }
};

export const daemonRequest = async (
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = 1000,
): Promise<DaemonResponse> => {
  return new Promise<DaemonResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("daemon_timeout"));
    }, timeoutMs);

    void Bun.connect<{ sent: boolean }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { sent: true };
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0 || settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
          } catch {
            reject(new Error("invalid_daemon_response"));
          }
          socket.end();
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("daemon_closed"));
        },
        error(_socket, error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
};

// Config load failures happen inside a child process whose stdio is
// "ignore" (see startDaemon), so the only way to name the cause for
// `tmux-autoname explain` and the diagnostic log is to write it here before
// rethrowing and letting the process exit.
export const describeConfigError = (error: unknown): string => {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    return `config_invalid: ${path}: ${issue?.message ?? "invalid configuration"}`;
  }
  return `config_parse_error: ${error instanceof Error ? error.message : String(error)}`;
};

export const logDiagnostic = async (path: string, code: string): Promise<void> => {
  try {
    const info = await stat(path).catch(() => undefined);
    if (info && info.size >= LOG_LIMIT_BYTES) {
      await rename(path, `${path}.1`).catch(() => undefined);
    }
    const file = await open(path, "a", 0o600);
    try {
      await file.write(`${JSON.stringify({ at: new Date().toISOString(), code })}\n`);
    } finally {
      await file.close();
    }
  } catch {
    // Automatic paths must remain silent even when diagnostics cannot be written.
  }
};
