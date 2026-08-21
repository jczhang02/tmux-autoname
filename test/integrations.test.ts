import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentMonitor } from "../src/daemon";
import type { RuntimeOutcome } from "../src/runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TMUX_AUTONAME_BIN;
  delete process.env.TMUX_AUTONAME_CAPTURE;
  delete process.env.TMUX_PANE;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("event integrations", () => {
  test("zsh emits only the command name and remains silent", async () => {
    const fixture = await captureFixture();
    const child = Bun.spawn(["zsh", "-dfi"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TMUX_PANE: "%43",
        TMUX_AUTONAME_BIN: fixture.executable,
        TMUX_AUTONAME_CAPTURE: fixture.output,
      },
    });
    child.stdin.write(
      `source ${JSON.stringify(join(process.cwd(), "integrations/tmux-autoname.zsh"))}\nprintf hidden-argument >/dev/null\nexit\n`,
    );
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("tmux-autoname:");

    const captures = await waitForCaptures(fixture.output, 2);
    const argumentsText = JSON.stringify(captures.map((capture) => capture.args));
    expect(argumentsText).toContain("command_started");
    expect(argumentsText).toContain("command_finished");
    expect(argumentsText).toContain("printf");
    expect(argumentsText).not.toContain("hidden-argument");
  });

  test("content monitor emits once only after the active pane is quiet", async () => {
    let content = "first screen";
    const settled: string[] = [];
    const monitor = new ContentMonitor({
      tmux: {
        activePanes: async () => ["%42"],
        capturePane: async () => content,
      },
      settleMs: 1000,
      onSettled: async (paneId) => {
        settled.push(paneId);
        return { kind: "scheduled", windowId: "@1" } satisfies RuntimeOutcome;
      },
    });

    await monitor.scan(0);
    await monitor.scan(999);
    expect(settled).toEqual([]);
    await monitor.scan(1000);
    await monitor.scan(2000);
    expect(settled).toEqual(["%42"]);

    content = "second screen";
    await monitor.scan(2100);
    await monitor.scan(3100);
    expect(settled).toEqual(["%42", "%42"]);

    content = "third screen";
    await monitor.scan(4000);
    content = "";
    await monitor.scan(4500);
    content = "third screen";
    await monitor.scan(5000);
    expect(settled).toHaveLength(2);
    await monitor.scan(6000);
    expect(settled).toHaveLength(3);
  });
});

type Capture = { args: string[]; stdin: string };

const captureFixture = async (): Promise<{ executable: string; output: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "tmux-autoname-integration-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "capture");
  const output = join(directory, "events.jsonl");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const stdin = await Bun.stdin.text();
await appendFile(process.env.TMUX_AUTONAME_CAPTURE, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
`,
  );
  await chmod(executable, 0o700);
  return { executable, output };
};

const waitForCaptures = async (path: string, count: number): Promise<Capture[]> => {
  const started = Date.now();
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    const captures = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Capture);
    if (captures.length >= count) return captures;
    if (Date.now() - started > 2000) throw new Error("integration events timed out");
    await Bun.sleep(20);
  }
};
