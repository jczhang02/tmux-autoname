import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxCliPort } from "../src/adapters";
import { describeConfigError, runDaemon, runtimePaths } from "../src/daemon";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TMUX_AUTONAME_CONFIG;
  delete process.env.XDG_RUNTIME_DIR;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

describe("daemon config failure diagnostics", () => {
  test("describeConfigError formats a real zod validation failure by path and message", async () => {
    const { z } = await import("zod");
    const schema = z.object({ ai: z.object({ provider: z.enum(["openai", "anthropic"]) }) });
    const result = schema.safeParse({ ai: { provider: "not-a-real-provider" } });
    expect(result.success).toBe(false);
    const message = describeConfigError(result.error);
    expect(message).toStartWith("config_invalid: ai.provider:");
  });

  test("describeConfigError falls back to config_parse_error for non-zod failures", () => {
    expect(describeConfigError(new SyntaxError("bad TOML on line 3"))).toBe(
      "config_parse_error: bad TOML on line 3",
    );
    expect(describeConfigError("not an Error instance")).toBe(
      "config_parse_error: not an Error instance",
    );
  });

  test("runDaemon logs a diagnostic and does not vanish when config TOML is malformed", async () => {
    const configDir = await tempDir("tmux-autoname-daemon-config-");
    const runtimeDir = await tempDir("tmux-autoname-daemon-runtime-");
    const configFile = join(configDir, "config.toml");
    await writeFile(configFile, "this is not [ valid toml", "utf8");
    process.env.TMUX_AUTONAME_CONFIG = configFile;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const tmux = new TmuxCliPort(join(runtimeDir, "fake.sock"));
    await expect(runDaemon(tmux)).rejects.toBeTruthy();

    const paths = runtimePaths(tmux.serverId, process.env);
    const log = await readFile(paths.log, "utf8");
    expect(log).toContain("config_parse_error");
  });

  test("runDaemon logs which config field failed validation", async () => {
    const configDir = await tempDir("tmux-autoname-daemon-config-");
    const runtimeDir = await tempDir("tmux-autoname-daemon-runtime-");
    const configFile = join(configDir, "config.toml");
    await writeFile(
      configFile,
      '[ai]\nprovider = "not-a-real-provider"\nmodel = "fast-model"\napi_key = "secret"\n',
      "utf8",
    );
    process.env.TMUX_AUTONAME_CONFIG = configFile;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const tmux = new TmuxCliPort(join(runtimeDir, "fake.sock"));
    await expect(runDaemon(tmux)).rejects.toBeTruthy();

    const paths = runtimePaths(tmux.serverId, process.env);
    const log = await readFile(paths.log, "utf8");
    expect(log).toContain("config_invalid");
    expect(log).toContain("provider");
  });
});
