import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shouldRun = process.env.TMUX_AUTONAME_RUN_SOAK === "1";
const durationMs = Number.parseInt(process.env.TMUX_AUTONAME_SOAK_MS ?? "1800000", 10);
const soak = shouldRun ? test : test.skip;

soak(
  "30-minute isolated daemon soak remains bounded and responsive",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tmux-autoname-soak-"));
    const label = `tmux-autoname-soak-${process.pid}`;
    const binary = join(process.cwd(), "dist/tmux-autoname");
    const runtimeDirectory = join(root, "runtime");
    const workspace = join(root, "partjobs");
    const configPath = join(root, "config.toml");
    const requests: number[] = [];
    let socket = "";
    let environment: Record<string, string> = {};

    const model = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const body = (await incoming.json()) as Record<string, unknown>;
        const serialized = JSON.stringify(body);
        requests.push(Buffer.byteLength(serialized));
        const workspaceId = serialized.match(/workspace:[a-f0-9]{20}/u)?.[0];
        const areaId = serialized.match(/area:[a-f0-9]{20}/u)?.[0] ?? null;
        if (!workspaceId) return Response.json({ error: "missing candidate" }, { status: 400 });
        return Response.json({
          id: "chatcmpl-soak",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "soak-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  workspaceId,
                  areaId,
                  task: "maintain soak window",
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

    const run = async (command: string[], env = environment) => {
      const child = Bun.spawn(command, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const tmux = (...args: string[]) => run(["tmux", "-L", label, ...args]);
    const cli = (...args: string[]) => run([binary, ...args]);

    try {
      await mkdir(runtimeDirectory, { mode: 0o700 });
      await mkdir(workspace, { recursive: true });
      for (let window = 0; window < 5; window += 1) {
        for (let change = 0; change < 8; change += 1) {
          await mkdir(join(workspace, `window-${window}`, `change-${change}`), {
            recursive: true,
          });
        }
      }
      await Bun.write(
        configPath,
        `[ai]
provider = "openai-compatible"
model = "soak-model"
base_url = "http://127.0.0.1:${model.port}/v1"

[limits]
debounce_ms = 5
minimum_call_interval_ms = 0
request_timeout_ms = 500
max_calls_per_window_hour = 6
max_calls_per_server_hour = 30
circuit_failure_threshold = 3
circuit_cooldown_ms = 600000
`,
      );

      expect((await tmux("-f", "/dev/null", "new-session", "-d", "-s", "partjobs", "-c", workspace)).exitCode).toBe(0);
      socket = (await tmux("display-message", "-p", "#{socket_path}")).stdout.trim();
      const serverPid = (await tmux("display-message", "-p", "#{pid}")).stdout.trim();
      environment = {
        TMUX: `${socket},${serverPid},0`,
        TMUX_AUTONAME_TMUX_SOCKET: socket,
        TMUX_AUTONAME_CONFIG: configPath,
        XDG_RUNTIME_DIR: runtimeDirectory,
      };
      for (const [key, value] of Object.entries(environment)) {
        expect((await tmux("set-environment", "-g", key, value)).exitCode).toBe(0);
      }
      const loader = await run(["sh", join(process.cwd(), "tmux-autoname.tmux")], {
        ...environment,
        TMUX_AUTONAME_BIN: binary,
      });
      expect(loader).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });

      const windows: Array<{ windowId: string; paneId: string }> = [];
      const first = (
        await tmux("display-message", "-p", "-t", "partjobs:0", "#{window_id}:#{pane_id}")
      ).stdout.trim();
      const [firstWindow, firstPane] = first.split(":");
      windows.push({ windowId: firstWindow!, paneId: firstPane! });
      for (let index = 1; index < 5; index += 1) {
        const created = (
          await tmux(
            "new-window",
            "-dP",
            "-F",
            "#{window_id}:#{pane_id}",
            "-t",
            "partjobs:",
            "-c",
            workspace,
          )
        ).stdout.trim();
        const [windowId, paneId] = created.split(":");
        windows.push({ windowId: windowId!, paneId: paneId! });
      }

      for (const window of windows) {
        await cli(
          "emit",
          "--source",
          "tmux",
          "--kind",
          "window_changed",
          "--window",
          window.windowId,
        );
      }
      await waitUntil(async () => {
        const files = await readdir(join(runtimeDirectory, "tmux-autoname")).catch(() => []);
        return files.some((file) => file.endsWith(".pid"));
      });

      for (let change = 0; change < 6; change += 1) {
        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index]!;
          const cwd = join(workspace, `window-${index}`, `change-${change}`);
          await tmux("send-keys", "-t", window.paneId, `cd ${JSON.stringify(cwd)}`, "Enter");
          await waitUntil(async () =>
            (
              await tmux(
                "display-message",
                "-p",
                "-t",
                window.paneId,
                "#{pane_current_path}",
              )
            ).stdout.trim() === cwd,
          );
          const emitted = await cli(
            "emit",
            "--source",
            "tmux",
            "--kind",
            "window_changed",
            "--window",
            window.windowId,
          );
          expect(emitted.stdout).toBe("");
          expect(emitted.stderr).toBe("");
          await waitUntil(async () => requests.length >= change * windows.length + index + 1);
        }
      }
      expect(requests).toHaveLength(30);

      const pidFiles = (await readdir(join(runtimeDirectory, "tmux-autoname"))).filter((file) =>
        file.endsWith(".pid"),
      );
      expect(pidFiles).toHaveLength(1);
      const daemonPid = Number.parseInt(
        await readFile(join(runtimeDirectory, "tmux-autoname", pidFiles[0]!), "utf8"),
        10,
      );
      const baseline = await metrics(daemonPid);
      const samples = [baseline];
      let eventCount = 0;
      const started = Date.now();
      let nextSample = started + 30_000;

      while (Date.now() - started < durationMs) {
        const window = windows[eventCount % windows.length]!;
        const emitted = await cli(
          "emit",
          "--source",
          "tmux",
          "--kind",
          "window_changed",
          "--window",
          window.windowId,
        );
        expect(emitted).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
        eventCount += 1;

        if (Date.now() >= nextSample) {
          samples.push(await metrics(daemonPid));
          const health = await cli("explain", "--window", window.windowId);
          expect(health.exitCode).toBe(0);
          process.stdout.write(
            `soak ${Math.floor((Date.now() - started) / 1000)}s events=${eventCount} cpu=${samples.at(-1)!.cpu}% rss=${samples.at(-1)!.rssKb}KB fds=${samples.at(-1)!.fds}\n`,
          );
          nextSample += 30_000;
        }
        await Bun.sleep(500);
      }

      samples.push(await metrics(daemonPid));
      const final = samples.at(-1)!;
      expect(requests).toHaveLength(30);
      expect(Math.max(...requests)).toBeLessThan(64 * 1024);
      expect(eventCount).toBeGreaterThanOrEqual(Math.floor(durationMs / 650));
      expect(final.rssKb).toBeLessThanOrEqual(baseline.rssKb + 32 * 1024);
      expect(Math.max(...samples.map((sample) => sample.rssKb))).toBeLessThanOrEqual(
        baseline.rssKb + 64 * 1024,
      );
      expect(final.fds).toBeLessThanOrEqual(baseline.fds + 8);
      expect(final.children).toBe(0);
      expect(final.cpu).toBeLessThanOrEqual(25);
      process.stdout.write(
        `soak complete events=${eventCount} requests=${requests.length} cpu=${final.cpu}% rss=${baseline.rssKb}->${final.rssKb}KB fds=${baseline.fds}->${final.fds}\n`,
      );
      for (const window of windows) {
        expect(
          (
            await tmux(
              "display-message",
              "-p",
              "-t",
              window.paneId,
              "#{pane_in_mode}",
            )
          ).stdout.trim(),
        ).toBe("0");
      }
    } finally {
      if (socket) await cli("daemon", "--stop").catch(() => undefined);
      await tmux("kill-server").catch(() => undefined);
      model.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  1_900_000,
);

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("soak setup timed out");
    await Bun.sleep(20);
  }
};

const metrics = async (
  pid: number,
): Promise<{ rssKb: number; fds: number; children: number; cpu: number }> => {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rssKb = Number.parseInt(status.match(/^VmRSS:\s+(\d+)/mu)?.[1] ?? "0", 10);
  const fds = (await readdir(`/proc/${pid}/fd`)).length;
  const processInfo = Bun.spawnSync(["ps", "-o", "%cpu=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const childInfo = Bun.spawnSync(["ps", "-o", "pid=", "--ppid", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const childLines = childInfo.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const cpu = Number.parseFloat(processInfo.stdout.toString().trim()) || 0;
  return { rssKb, fds, children: childLines.length, cpu };
};
