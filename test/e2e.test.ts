import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./helpers";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
const TEST_SECRET = "e2e-provider-secret";

const run = async (
  command: string[],
  options: { env?: Record<string, string>; stdin?: string; allowFailure?: boolean } = {},
): Promise<CommandResult> => {
  const child = Bun.spawn(command, {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("child stdin unavailable");
    stdin.write(options.stdin);
    stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command[0]} exited ${exitCode}: ${stderr}`);
  }
  return { exitCode, stdout, stderr };
};

const waitFor = async <T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> => {
  const started = Date.now();
  let value = await read();
  while (!accept(value)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`condition timed out; last value: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(20);
    value = await read();
  }
  return value;
};

describe.serial("compiled isolated tmux E2E", () => {
  let testRoot = "";
  let workspace = "";
  let nested = "";
  let socket = "";
  let tmuxEnv = "";
  let paneId = "";
  let windowId = "";
  let configPath = "";
  let label = "";
  let env: Record<string, string>;
  let mode: "valid" | "auth" | "timeout" | "gated" = "valid";
  let task = "redesign naming plugin";
  let gate = deferred<void>();
  const requests: Record<string, unknown>[] = [];
  const authorizations: Array<string | null> = [];

  const modelServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      authorizations.push(request.headers.get("authorization"));
      if (mode === "auth") {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      }
      if (mode === "timeout") await Bun.sleep(500);
      if (mode === "gated") await gate.promise;
      const serialized = JSON.stringify(body);
      const workspaceId = serialized.match(/workspace:[a-f0-9]{20}/u)?.[0];
      const areaId = serialized.match(/area:[a-f0-9]{20}/u)?.[0] ?? null;
      if (!workspaceId) return Response.json({ error: { message: "bad evidence" } }, { status: 400 });
      return Response.json({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "e2e-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                workspaceId,
                areaId,
                task,
                taskDecision: "replace",
                confidence: 0.95,
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });

  const tmux = (...args: string[]) => run(["tmux", "-L", label, ...args]);
  const cli = (...args: string[]) => run([join(process.cwd(), "dist/tmux-autoname"), ...args], { env });
  const explain = async () => {
    const result = await cli("explain", "--window", windowId);
    return JSON.parse(result.stdout) as {
      mode: string;
      visibleName: string;
      badge: { text: string };
      limits: {
        windowCallsLastHour: number;
        serverCallsLastHour: number;
        circuitOpenUntil?: number;
      };
      record?: { task: string };
    };
  };
  const name = async () =>
    (await tmux("display-message", "-p", "-t", windowId, "#{window_name}")).stdout.trim();
  const badge = async () =>
    (
      await tmux(
        "display-message",
        "-p",
        "-t",
        windowId,
        "#{@tmux-autoname-badge}",
      )
    ).stdout.trim();
  const emitSettled = async () =>
    run([join(process.cwd(), "dist/tmux-autoname"), "emit"], {
      env,
      stdin: JSON.stringify({
        version: 1,
        source: "tmux",
        kind: "content_settled",
        windowId,
        paneId,
      }),
    });
  const setTerminalContext = async (text: string) => {
    await tmux("send-keys", "-t", paneId, "C-u");
    const quoted = `'${`Task: ${text}`.replaceAll("'", `'"'"'`)}'`;
    await tmux("send-keys", "-l", "-t", paneId, `printf '%s\\n' ${quoted}`);
    await tmux("send-keys", "-t", paneId, "Enter");
    await waitFor(
      async () => (await tmux("capture-pane", "-p", "-t", paneId)).stdout,
      (value) => value.includes(text),
    );
    await waitFor(
      async () => (await tmux("display-message", "-p", "-t", paneId, "#{pane_current_command}"))
        .stdout.trim(),
      (value) => value === "zsh",
    );
    await Bun.sleep(50);
    return emitSettled();
  };

  beforeAll(async () => {
    const build = await run(["bun", "run", "build"]);
    expect(build.stderr).not.toContain("error");

    testRoot = await mkdtemp(join(tmpdir(), "tmux-autoname-e2e-"));
    workspace = join(testRoot, "partjobs");
    nested = join(workspace, "high-value-patent-rebuild", "manuscript");
    await mkdir(nested, { recursive: true });
    await mkdir(join(testRoot, "runtime"), { mode: 0o700 });
    configPath = join(testRoot, "config.toml");
    await Bun.write(
      configPath,
      `[ai]
provider = "openai-compatible"
model = "e2e-model"
base_url = "http://127.0.0.1:${modelServer.port}/v1"
confidence_threshold = 0.6

[ai.credential]
source = "env"
name = "TMUX_AUTONAME_E2E_KEY"

[limits]
debounce_ms = 10
scan_interval_ms = 60000
content_settle_ms = 10
minimum_call_interval_ms = 0
request_timeout_ms = 100
max_calls_per_window_hour = 10
max_calls_per_server_hour = 30
circuit_failure_threshold = 3
circuit_cooldown_ms = 500
`,
    );

    label = `tmux-autoname-e2e-${process.pid}`;
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "partjobs", "-c", workspace);
    socket = (await tmux("display-message", "-p", "#{socket_path}")).stdout.trim();
    const serverPid = (await tmux("display-message", "-p", "#{pid}")).stdout.trim();
    tmuxEnv = `${socket},${serverPid},0`;
    env = {
      TMUX: tmuxEnv,
      TMUX_AUTONAME_TMUX_SOCKET: socket,
      TMUX_AUTONAME_CONFIG: configPath,
      TMUX_AUTONAME_E2E_KEY: TEST_SECRET,
      XDG_RUNTIME_DIR: join(testRoot, "runtime"),
    };
    for (const [key, value] of Object.entries(env)) {
      await tmux("set-environment", "-g", key, value);
    }

    const loader = await run(["sh", join(process.cwd(), "tmux-autoname.tmux")], {
      env: { ...env, TMUX_AUTONAME_BIN: join(process.cwd(), "dist/tmux-autoname") },
    });
    expect(loader.stdout).toBe("");
    expect(loader.stderr).toBe("");

    const created = (
      await tmux(
        "new-window",
        "-dP",
        "-F",
        "#{window_id}:#{pane_id}",
        "-t",
        "partjobs:",
        "-n",
        "work",
        "-c",
        nested,
      )
    ).stdout.trim();
    [windowId, paneId] = created.split(":") as [string, string];
    await waitFor(name, (value) => value === "zsh:partjobs/high-value-patent-rebuild/manuscript");
  }, 15000);

  afterAll(async () => {
    await cli("daemon", "--stop").catch(() => undefined);
    await tmux("kill-server").catch(() => undefined);
    modelServer.stop(true);
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  test("automatic hooks stay silent, idempotent, and outside tmux view mode", async () => {
    const quotedBinary = join(testRoot, "tmux-autoname'quoted");
    await symlink(join(process.cwd(), "dist/tmux-autoname"), quotedBinary);
    const secondLoad = await run(["sh", join(process.cwd(), "tmux-autoname.tmux")], {
      env: { ...env, TMUX_AUTONAME_BIN: quotedBinary },
    });
    expect(secondLoad.stdout).toBe("");
    expect(secondLoad.stderr).toBe("");

    const runtimeDirectory = join(testRoot, "runtime", "tmux-autoname");
    expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o700);
    const runtimeFiles = await readdir(runtimeDirectory);
    expect(runtimeFiles.filter((file) => file.endsWith(".pid"))).toHaveLength(1);
    for (const file of runtimeFiles.filter((value) => /\.(?:sock|pid|log)$/u.test(value))) {
      expect((await stat(join(runtimeDirectory, file))).mode & 0o777).toBe(0o600);
    }

    for (const option of ["window-status-format", "window-status-current-format"]) {
      const format = (await tmux("show-option", "-gv", option)).stdout;
      expect(format.match(/#\{@tmux-autoname-badge\}/gu)).toHaveLength(2);
    }
    const hookedWindow = (
      await tmux("new-window", "-dP", "-F", "#{window_id}", "-t", "partjobs:", "-c", workspace)
    ).stdout.trim();
    await waitFor(
      async () => (await tmux("display-message", "-p", "-t", hookedWindow, "#{window_name}"))
        .stdout.trim(),
      (value) => value === "zsh:partjobs",
    );
    await tmux("kill-window", "-t", hookedWindow);
    expect(
      (await tmux("display-message", "-p", "-t", paneId, "#{pane_in_mode}")).stdout.trim(),
    ).toBe("0");
  });

  test("uses real AI SDK HTTP with captured terminal content", async () => {
    const automatic = await setTerminalContext("Please redesign the naming plugin");
    expect(automatic.stdout).toBe("");
    expect(automatic.stderr).toBe("");
    await waitFor(async () => requests.length, (value) => value === 1);
    await waitFor(explain, (value) => value.record?.task === "redesign naming plugin");
    expect(await name()).toEndWith("/redesign naming plugin");
    expect(requests).toHaveLength(1);

    await emitSettled();
    await Bun.sleep(150);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("Please redesign the naming plugin");
    expect(authorizations[0]).toBe(`Bearer ${TEST_SECRET}`);
  }, 10000);

  test("Activity changes locally and an inactive pane cannot rename the window", async () => {
    const fakeNvim = join(testRoot, "nvim");
    const fakePytest = join(testRoot, "pytest");
    await symlink("/usr/bin/sleep", fakeNvim);
    await symlink("/usr/bin/sleep", fakePytest);
    const beforeCalls = requests.length;

    await tmux("send-keys", "-t", paneId, "C-u");
    await tmux("send-keys", "-t", paneId, `${fakeNvim} 30`, "Enter");
    await waitFor(
      async () => (await tmux("display-message", "-p", "-t", paneId, "#{pane_current_command}"))
        .stdout.trim(),
      (value) => value === "nvim",
    );
    await run([join(process.cwd(), "dist/tmux-autoname"), "emit", "--source", "tmux", "--kind", "window_changed", "--window", windowId], { env });
    await waitFor(name, (value) => value.startsWith("nvim:"));

    const inactive = (
      await tmux("split-window", "-dP", "-F", "#{pane_id}", "-t", windowId, fakePytest, "30")
    ).stdout.trim();
    await run([join(process.cwd(), "dist/tmux-autoname"), "emit", "--source", "tmux", "--kind", "window_changed", "--window", windowId], { env });
    await Bun.sleep(100);
    expect(await name()).toStartWith("nvim:");
    expect(requests).toHaveLength(beforeCalls);
    await tmux("kill-pane", "-t", inactive);
    await tmux("send-keys", "-t", paneId, "C-c");
    await waitFor(
      async () => (await tmux("display-message", "-p", "-t", paneId, "#{pane_current_command}"))
        .stdout.trim(),
      (value) => value === "zsh",
    );
  });

  test("stale AI cannot overwrite Manual Name and auto restores the record", async () => {
    mode = "gated";
    gate = deferred<void>();
    task = "replace with stale task";
    const beforeCalls = requests.length;
    await setTerminalContext("Start a different task");
    await waitFor(async () => requests.length, (value) => value === beforeCalls + 1);

    await tmux("rename-window", "-t", windowId, "manual e2e name");
    await waitFor(explain, (value) => value.mode === "manual");
    expect(await badge()).toBe("M");
    gate.resolve();
    await Bun.sleep(150);
    expect(await name()).toBe("manual e2e name");
    await cli("daemon", "--stop");
    await Bun.sleep(100);
    await cli("daemon");
    await waitFor(explain, (value) => value.mode === "manual");
    expect(await name()).toBe("manual e2e name");

    await tmux("rename-window", "-t", windowId, "");
    await waitFor(explain, (value) => value.mode === "automatic");
    expect(await name()).not.toBe("manual e2e name");
    mode = "valid";
    task = "redesign naming plugin";
  });

  test("timeout and authentication failures retain the name and set badges", async () => {
    const retained = await name();
    mode = "timeout";
    await cli("refresh", "--window", windowId);
    await waitFor(badge, (value) => value === "!");
    expect(await name()).toBe(retained);
    await cli("secrets", "reload");

    mode = "auth";
    await cli("refresh", "--window", windowId);
    await waitFor(badge, (value) => value === "K!");
    expect(await name()).toBe(retained);
    await cli("secrets", "reload");
  });

  test("circuit breaker, automatic quota, and recovery work through the daemon", async () => {
    mode = "valid";
    task = "reset failure counter";
    const beforeReset = requests.length;
    await cli("refresh", "--window", windowId);
    await waitFor(async () => requests.length, (value) => value === beforeReset + 1);
    await waitFor(name, (value) => value.endsWith("/reset failure counter"));

    mode = "auth";
    const beforeFailures = requests.length;
    for (let index = 0; index < 3; index += 1) {
      await cli("refresh", "--window", windowId);
      await waitFor(async () => requests.length, (value) => value === beforeFailures + index + 1);
      await waitFor(badge, (value) => value === "K!");
    }
    const afterFailures = requests.length;
    await setTerminalContext("This call must be blocked");
    await Bun.sleep(50);
    expect(requests).toHaveLength(afterFailures);
    expect((await explain()).limits.circuitOpenUntil).toBeNumber();

    await Bun.sleep(520);
    mode = "valid";
    task = "recover naming service";
    await setTerminalContext("Recover after the cooldown");
    await waitFor(async () => requests.length, (value) => value === afterFailures + 1);
    await waitFor(name, (value) => value.endsWith("/recover naming service"));

    let report = await explain();
    let sessionIndex = 0;
    while (report.limits.windowCallsLastHour < 10) {
      task = `handle quota event ${sessionIndex}`;
      await setTerminalContext(`Quota task ${sessionIndex}`);
      await waitFor(
        explain,
        (value) => value.limits.windowCallsLastHour > report.limits.windowCallsLastHour,
      );
      report = await explain();
      sessionIndex += 1;
    }
    const atQuota = requests.length;
    await setTerminalContext("This automatic call must not run");
    await Bun.sleep(100);
    expect(requests).toHaveLength(atQuota);
    expect((await explain()).limits.windowCallsLastHour).toBe(10);
  });

  test("daemon restart restores safe persisted state", async () => {
    const before = await explain();
    await cli("daemon", "--stop");
    await Bun.sleep(100);
    await cli("daemon");
    const after = await waitFor(explain, (value) => value.record !== undefined);
    expect(after.record).toEqual(before.record);
    expect(after.visibleName).toBe(before.visibleName);
    expect(after.limits).toMatchObject({
      windowCallsLastHour: before.limits.windowCallsLastHour,
      serverCallsLastHour: before.limits.serverCallsLastHour,
    });
    const requestCount = requests.length;
    await setTerminalContext("Do not bypass the restored quota");
    await Bun.sleep(100);
    expect(requests).toHaveLength(requestCount);

    const encoded = (
      await tmux(
        "display-message",
        "-p",
        "-t",
        windowId,
        "#{@tmux-autoname-state}",
      )
    ).stdout.trim();
    const persisted = Buffer.from(encoded, "base64url").toString("utf8");
    const serverEncoded = (
      await tmux("show-option", "-gqv", "@tmux-autoname-server-state")
    ).stdout.trim();
    const persistedServer = Buffer.from(serverEncoded, "base64url").toString("utf8");
    const runtimeFiles = await readdir(join(testRoot, "runtime", "tmux-autoname"));
    const logs = await Promise.all(
      runtimeFiles
        .filter((file) => file.endsWith(".log"))
        .map((file) => readFile(join(testRoot, "runtime", "tmux-autoname", file), "utf8")),
    );
    expect(persisted).not.toContain("Please redesign");
    expect(
      `${persisted}${persistedServer}${await readFile(configPath, "utf8")}${logs.join("")}`,
    ).not.toContain(TEST_SECRET);
  });
});
