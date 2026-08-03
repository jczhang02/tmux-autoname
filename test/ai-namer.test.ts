import { describe, expect, test } from "bun:test";
import {
	MAX_SAMPLE_BYTES,
	PiCliLlmAdapter,
	buildNamingPrompt,
	cleanAiSlug,
	contentAfterHeader,
	createAiCandidate,
	detectAiTool,
	sampleContent,
} from "../src/ai-namer.ts";
import type { CommandResult } from "../src/types.ts";
import { pane, testConfig } from "./helpers.ts";

describe("AI naming pipeline", () => {
	test("contentAfterHeader strips pi startup header", () => {
		const lines = [
			"banner",
			"Current working directory: /x",
			"real task",
			"more",
		];
		expect(contentAfterHeader(lines, "pi")).toEqual(["real task", "more"]);
	});

	test("window names alone never classify a pane as an AI tool", () => {
		expect(
			detectAiTool(
				pane({ paneCommand: "zsh", windowName: "claude" }),
				{
					pid: 101,
					ppid: 100,
					comm: "zsh",
					args: "zsh",
				},
				testConfig(),
			),
		).toBeNull();
	});

	test("sampleContent strips ANSI and keeps head plus tail", () => {
		const config = testConfig({
			naming: { ...testConfig().naming, headLines: 2, tailLines: 2 },
		});
		const sampled = sampleContent(
			["\u001b[31mred\u001b[0m", "two", "three", "four", "five"],
			config,
		);
		expect(sampled.nonEmptyCount).toBe(5);
		expect(sampled.sample).toBe(
			"red\ntwo\n\n[...1 lines omitted...]\n\nfour\nfive",
		);
	});

	test("sampleContent has a hard byte limit", () => {
		for (const content of [
			"x".repeat(MAX_SAMPLE_BYTES * 2),
			"你".repeat(MAX_SAMPLE_BYTES),
		]) {
			const sampled = sampleContent([content], testConfig());
			expect(Buffer.byteLength(sampled.sample, "utf8")).toBeLessThanOrEqual(
				MAX_SAMPLE_BYTES,
			);
		}
	});

	test("buildNamingPrompt contains cwd and current window name", () => {
		const prompt = buildNamingPrompt(
			"pi",
			pane({ panePath: "/repo", windowName: "tmux" }),
			"task",
			12,
		);
		expect(prompt).toContain("Launch cwd: /repo");
		expect(prompt).toContain("Current tmux window name: tmux");
		expect(prompt).toContain("Max 12 characters");
	});

	test("cleanAiSlug removes tool and generic words", () => {
		expect(cleanAiSlug("pi coding-agent tmux plugin", "pi")).toBe(
			"tmux-plugin",
		);
		expect(cleanAiSlug("assistant", "pi")).toBeNull();
	});

	test("createAiCandidate locks successful AI names", async () => {
		const config = testConfig({
			naming: { ...testConfig().naming, minNonEmptyLines: 2 },
		});
		const candidate = await createAiCandidate(
			pane({ paneCommand: "pi" }),
			"pi",
			[
				"Current working directory: /repo",
				"restore old newspaper scan",
				"fix delivery script",
			],
			config,
			{ generateSlug: async () => "newspaper restoration" },
			() => undefined,
		);
		expect(candidate).toEqual({
			name: "pi:newspaper-restoration",
			tool: "pi",
			source: "ai",
			lock: true,
		});
	});

	test("createAiCandidate skips content below threshold", async () => {
		const config = testConfig({
			naming: { ...testConfig().naming, minNonEmptyLines: 3 },
		});
		const candidate = await createAiCandidate(
			pane({ paneCommand: "pi" }),
			"pi",
			["Current working directory: /repo", "one line"],
			config,
			{ generateSlug: async () => "should-not-run" },
			() => undefined,
		);
		expect(candidate).toBeNull();
	});

	test("PiCliLlmAdapter calls pi with configured provider and model", async () => {
		const calls: Array<{
			args: string[];
			stdin?: string;
			options?: { maxBuffer?: number; timeoutMs?: number };
		}> = [];
		const adapter = new PiCliLlmAdapter(
			async (args, stdin, _env, options): Promise<CommandResult> => {
				calls.push({ args, stdin, options });
				return { stdout: "`pi tmux plugin`\n", stderr: "", exitCode: 0 };
			},
			() => undefined,
		);
		const slug = await adapter.generateSlug({
			tool: "pi",
			pane: pane({ paneCommand: "pi" }),
			content: "tmux plugin refactor",
			config: testConfig(),
		});
		expect(slug).toBe("tmux-plugin");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toContain("--provider");
		expect(calls[0]?.args).toContain("openai-codex");
		expect(calls[0]?.args).toContain("--model");
		expect(calls[0]?.args).toContain("gpt-5.4-mini");
		expect(calls[0]?.stdin).toContain("tmux plugin refactor");
		expect(calls[0]?.options?.timeoutMs).toBe(45_000);
		expect(calls[0]?.options?.maxBuffer).toBe(128 * 1024);
		expect(calls[0]?.args).not.toContain("timeout");
	});

	test("provider failures never copy stderr into logs", async () => {
		const logs: string[] = [];
		const adapter = new PiCliLlmAdapter(
			async () => ({
				stdout: "",
				stderr: "canary-secret\nprovider details",
				exitCode: 1,
			}),
			(message) => logs.push(message),
		);
		expect(
			await adapter.generateSlug({
				tool: "pi",
				pane: pane(),
				content: "task",
				config: testConfig({ llm: { enabled: true } }),
			}),
		).toBeNull();
		expect(logs.join("\n")).not.toContain("canary-secret");
		expect(logs[0]).toContain("stderr_bytes=");
	});

	test("invalid provider output never appears in logs", async () => {
		const logs: string[] = [];
		const adapter = new PiCliLlmAdapter(
			async () => ({ stdout: "canary assistant", stderr: "", exitCode: 0 }),
			(message) => logs.push(message),
		);
		expect(
			await adapter.generateSlug({
				tool: "canary",
				pane: pane(),
				content: "task",
				config: testConfig({ llm: { enabled: true } }),
			}),
		).toBeNull();
		expect(logs.join("\n")).not.toContain("canary");
	});
});
