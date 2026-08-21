import { afterEach, describe, expect, test } from "bun:test";
import {
  AiSdkModel,
  CredentialResolver,
  runProcess,
  sanitizeTerminalContext,
} from "../src/adapters";
import { credentialCommand, defaultConfig, loadConfig } from "../src/config";
import type { NameRequest } from "../src/domain";
import { ProviderAuthenticationError } from "../src/runtime";
import { proposalFor, windowSnapshot } from "./helpers";
import { buildScopeCandidates, evidenceFingerprint } from "../src/domain";

const TEST_KEY_NAME = "TMUX_AUTONAME_TEST_API_KEY";

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
    expect(config.limits.max_calls_per_window_hour).toBe(6);
  });

  test("parses references and rejects literal API keys", async () => {
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
});

describe("AI SDK model adapter", () => {
  test("uses real structured-output HTTP transport with one bounded request", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const request = nameRequest("Please redesign the tmux naming plugin");
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const body = (await incoming.json()) as Record<string, unknown>;
        requests.push({ headers: incoming.headers, body });
        return Response.json(chatCompletion(proposalFor(request)));
      },
    });

    try {
      const model = new AiSdkModel({
        provider: "openai-compatible",
        model: "test-model",
        base_url: `http://127.0.0.1:${server.port}/v1`,
        supports_structured_outputs: true,
        confidence_threshold: 0.6,
      });
      const result = await model.propose(request, new AbortController().signal);

      expect(result.task).toBe("redesign naming plugin");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.max_tokens).toBe(64);
      expect(JSON.stringify(requests[0]?.body)).toContain("Please redesign the tmux naming plugin");
      expect(requests[0]?.headers.get("authorization")).toBeNull();
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
    activity: "codex",
    candidates,
    event,
    activePane: { cwd: active.cwd, command: active.command, title: active.title },
    terminalContext: prompt,
    supportingPanes: [],
  };
};

const chatCompletion = (proposal: ReturnType<typeof proposalFor>) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: JSON.stringify(proposal) },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});
