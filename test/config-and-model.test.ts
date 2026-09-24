import { afterEach, describe, expect, test } from "bun:test";
import {
  AiSdkModel,
  CredentialResolver,
  resolveSystemdRunCommand,
  runProcess,
  sanitizeTerminalContext,
} from "../src/adapters";
import { credentialCommand, defaultConfig, loadConfig } from "../src/config";
import type { NameRequest } from "../src/domain";
import { ProviderAuthenticationError } from "../src/runtime";
import { proposalFor, windowSnapshot } from "./helpers";
import { buildScopeCandidates, evidenceFingerprint } from "../src/domain";

const TEST_KEY_NAME = "TMUX_AUTONAME_TEST_API_KEY";
const TEST_API_KEY = "test-secret";

afterEach(() => {
  delete process.env[TEST_KEY_NAME];
});

describe("configuration and credentials", () => {
  test("uses safe defaults when config is absent", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const config = await loadConfig("/missing", async () => {
      throw missing;
    });
    expect(config.ai).toBeUndefined();
    expect(config.limits.scan_interval_ms).toBe(3000);
    expect(config.limits.content_settle_ms).toBe(4000);
    expect(config.limits.request_timeout_ms).toBe(15000);
    expect(config.limits.max_calls_per_window_hour).toBe(6);
  });

  test("accepts a credential reference or plaintext API key, but not both", async () => {
    const config = await loadConfig("memory", async () => `
[ai]
provider = "openai"
model = "fast-model"

[ai.credential]
source = "onepassword"
ref = "op://Private/OpenAI/api-key"
`);
    expect(config.ai?.credential).toEqual({
      source: "onepassword",
      ref: "op://Private/OpenAI/api-key",
    });

    const plaintext = await loadConfig("memory", async () => `
[ai]
provider = "openai"
model = "fast-model"
api_key = "plaintext"
`);
    expect(plaintext.ai?.api_key).toBe("plaintext");

    await expect(
      loadConfig("memory", async () => `
[ai]
provider = "openai"
model = "fast-model"
api_key = "plaintext"

[ai.credential]
source = "env"
name = "OPENAI_API_KEY"
`),
    ).rejects.toThrow();

    await expect(
      loadConfig("memory", async () => 'api_key = "plaintext"'),
    ).rejects.toThrow();
  });

  test("caches a resolved credential until explicitly cleared", async () => {
    process.env[TEST_KEY_NAME] = "first-value";
    const resolver = new CredentialResolver({ source: "env", name: TEST_KEY_NAME });
    expect(await resolver.resolve()).toBe("first-value");
    process.env[TEST_KEY_NAME] = "second-value";
    expect(await resolver.resolve()).toBe("first-value");
    resolver.clear();
    expect(await resolver.resolve()).toBe("second-value");
  });

  test("maps password-manager references to argument arrays", () => {
    expect(
      credentialCommand({ source: "onepassword", ref: "op://Private/OpenAI/api-key" }).command,
    ).toEqual(["op", "read", "--no-newline", "op://Private/OpenAI/api-key"]);
    expect(
      credentialCommand({ source: "keyring", service: "tmux-autoname", account: "openai" })
        .command,
    ).toEqual([
      "secret-tool",
      "lookup",
      "service",
      "tmux-autoname",
      "account",
      "openai",
    ]);
    expect(credentialCommand({ source: "env", name: "OPENAI_API_KEY" }).command).toEqual([]);
  });

  test("bounds helper process output", async () => {
    await expect(
      runProcess(
        [process.execPath, "-e", 'process.stdout.write("x".repeat(20000))'],
        { maxOutputBytes: 1024 },
      ),
    ).rejects.toThrow("process_output_limit");
  });

  test("bounds and redacts terminal context before model use", () => {
    const context = sanitizeTerminalContext(
      `Authorization: Bearer abc.def.ghi\napi_key=sk-secretvalue123456\n${"x".repeat(20_000)}`,
    );
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(8 * 1024);
    expect(context.split("\n").length).toBeLessThanOrEqual(50);
    expect(context).not.toContain("abc.def.ghi");
    expect(context).not.toContain("sk-secretvalue123456");
  });

  test("resolves the executable behind a foreground systemd-run", async () => {
    const reads: Array<[string, number]> = [];
    const command = await resolveSystemdRunCommand(41, async (path, limit) => {
      reads.push([path, limit]);
      if (path === "/proc/41/stat") {
        return Buffer.from("41 (zsh) S 1 41 41 34816 900 0 0 0");
      }
      return Buffer.from("/usr/bin/systemd-run\0--user\0--wait\0--\0/opt/codex\0resume\0");
    });

    expect(command).toBe("codex");
    expect(reads).toEqual([
      ["/proc/41/stat", 4 * 1024],
      ["/proc/900/cmdline", 64 * 1024],
    ]);
    expect(
      await resolveSystemdRunCommand(41, async (path) =>
        Buffer.from(path.endsWith("/stat")
          ? "41 (zsh) S 1 41 41 34816 900 0 0 0"
          : "/usr/bin/systemd-run\0--user\0"),
      ),
    ).toBeUndefined();
  });
});

describe("AI SDK model adapter", () => {
  test("uses one bounded JSON request with compatible gateway finish reasons", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const request = nameRequest("Please redesign the tmux naming plugin");
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const body = (await incoming.json()) as Record<string, unknown>;
        requests.push({ headers: incoming.headers, body });
        return Response.json(chatCompletion(proposalFor(request, "redesign-naming-plugin")));
      },
    });

    try {
      const model = new AiSdkModel({
        provider: "openai-compatible",
        model: "test-model",
        base_url: `http://127.0.0.1:${server.port}/v1`,
        supports_structured_outputs: true,
        confidence_threshold: 0.6,
        api_key: TEST_API_KEY,
      });
      const result = await model.propose(request, new AbortController().signal);

      expect(result).toMatchObject({ outcome: "propose", task: "redesign-naming-plugin" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.max_tokens).toBe(512);
      expect(JSON.stringify(requests[0]?.body)).toContain("Please redesign the tmux naming plugin");
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    } finally {
      server.stop(true);
    }
  });

  test("does not retry provider failures and clears authentication state", async () => {
    process.env[TEST_KEY_NAME] = "test-secret";
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      },
    });
    const request = nameRequest("Please redesign the plugin");

    try {
      const model = new AiSdkModel({
        provider: "openai-compatible",
        model: "test-model",
        base_url: `http://127.0.0.1:${server.port}/v1`,
        supports_structured_outputs: true,
        confidence_threshold: 0.6,
        credential: { source: "env", name: TEST_KEY_NAME },
      });
      await expect(model.propose(request, new AbortController().signal)).rejects.toBeInstanceOf(
        ProviderAuthenticationError,
      );
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("classifies malformed provider JSON without exposing the response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(chatCompletion("not-json"));
      },
    });
    try {
      const model = new AiSdkModel({
        provider: "openai-compatible",
        model: "test-model",
        base_url: `http://127.0.0.1:${server.port}/v1`,
        supports_structured_outputs: true,
        confidence_threshold: 0.6,
        api_key: TEST_API_KEY,
      });
      await expect(model.propose(nameRequest("test malformed output"), AbortSignal.timeout(1000)))
        .rejects.toThrow("invalid_model_response");
    } finally {
      server.stop(true);
    }
  });
});

const nameRequest = (prompt: string): NameRequest => {
  const snapshot = windowSnapshot();
  const candidates = buildScopeCandidates(snapshot);
  const event = {
    version: 1 as const,
    source: "tmux" as const,
    kind: "content_settled" as const,
    windowId: "@1",
  };
  const active = snapshot.panes[0]!;
  return {
    serverId: snapshot.serverId,
    windowId: "@1",
    revision: 1,
    fingerprint: evidenceFingerprint(snapshot, candidates, prompt),
    structureFingerprint: evidenceFingerprint(snapshot, candidates, ""),
    activity: "codex",
    candidates,
    event,
    activePane: { cwd: active.cwd, command: active.command, title: active.title },
    terminalContext: prompt,
    supportingPanes: [],
  };
};

const chatCompletion = (proposal: ReturnType<typeof proposalFor> | string) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "test-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: typeof proposal === "string" ? proposal : JSON.stringify(proposal),
      },
      finish_reason: "other",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});
