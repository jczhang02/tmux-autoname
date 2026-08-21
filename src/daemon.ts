import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkModel, TmuxCliPort } from "./adapters";
import { loadConfig } from "./config";
import { semanticEventSchema, type SemanticEvent } from "./domain";
import { AutonameRuntime, type ExplainReport, type RuntimeOutcome } from "./runtime";

const MAX_MESSAGE_BYTES = 16 * 1024;
const LOG_LIMIT_BYTES = 64 * 1024;

export type RuntimePaths = {
  directory: string;
  socket: string;
  log: string;
  pid: string;
};

export type DaemonRequest =
  | { type: "ping" }
  | { type: "event"; event: SemanticEvent; wait?: boolean }
  | { type: "explain"; windowId?: string; paneId?: string }
  | { type: "shutdown" };

export type DaemonResponse =
  | { ok: true; result?: RuntimeOutcome | ExplainReport }
  | { ok: false; error: string };

type ContentObservation = { digest: string; changedAt: number; emitted: boolean };

export class ContentMonitor {
  readonly #tmux: Pick<TmuxCliPort, "activePanes" | "capturePane">;
  readonly #settleMs: number;
  readonly #onSettled: (paneId: string) => Promise<RuntimeOutcome>;
  readonly #observations = new Map<string, ContentObservation>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #scanning = false;

  constructor(options: {
    tmux: Pick<TmuxCliPort, "activePanes" | "capturePane">;
    settleMs: number;
    onSettled: (paneId: string) => Promise<RuntimeOutcome>;
  }) {
    this.#tmux = options.tmux;
    this.#settleMs = options.settleMs;
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
  }

  async scan(now = Date.now()): Promise<void> {
    if (this.#scanning) return;
    this.#scanning = true;
    try {
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
  };
};

export const startDaemon = async (tmux: TmuxCliPort): Promise<void> => {
  const paths = runtimePaths(tmux.serverId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  if (await daemonRequest(paths.socket, { type: "ping" }, 200).catch(() => undefined)) {
    return;
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
    if (response?.ok) return;
  }
  await logDiagnostic(paths.log, "daemon_start_failed");
};

export const runDaemon = async (tmux: TmuxCliPort): Promise<void> => {
  const paths = runtimePaths(tmux.serverId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);

  if (await daemonRequest(paths.socket, { type: "ping" }, 150).catch(() => undefined)) {
    return;
  }
  await unlink(paths.socket).catch(() => undefined);

  const config = await loadConfig();
  const runtime = new AutonameRuntime({
    tmux,
    config,
    ...(config.ai ? { model: new AiSdkModel(config.ai) } : {}),
  });
  const monitor = config.ai
    ? new ContentMonitor({
        tmux,
        settleMs: config.limits.content_settle_ms,
        onSettled: (paneId) =>
          runtime.handle({ version: 1, source: "tmux", kind: "content_settled", paneId }),
      })
    : undefined;
  monitor?.start(config.limits.scan_interval_ms);
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
    monitor?.stop();
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
        return { ok: true };
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
