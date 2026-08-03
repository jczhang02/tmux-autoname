import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	configPaths,
	decodeConfig,
	defaultConfigToml,
	ensureConfig,
} from "../src/config-codec.ts";

describe("ConfigCodec", () => {
	test("default TOML is the single source for example config", () => {
		const example = readFileSync(
			join(import.meta.dir, "..", "config", "config.example.toml"),
			"utf8",
		);
		expect(defaultConfigToml()).toBe(example);
		expect(example).toContain('provider = "openai-codex"');
		expect(example).toContain('model = "gpt-5.4-mini"');
		expect(example).toContain("enabled = false");
	});

	test("decodeConfig normalizes tool names", () => {
		const result = decodeConfig({
			llm: { enabled: true },
			tools: {
				ai: ["π", "claude-code"],
				shells: ["/bin/zsh"],
				editors: ["NVIM"],
			},
		});
		expect(result.config.llm.enabled).toBe(true);
		expect(result.config.tools.ai).toEqual(["pi", "claude"]);
		expect(result.config.tools.shells).toEqual(["zsh"]);
		expect(result.config.tools.editors).toEqual(["nvim"]);
	});

	test("decodeConfig falls back with warnings for invalid values", () => {
		const result = decodeConfig({
			llm: { provider: 42, timeout_seconds: -1 },
			naming: { max_len: 0, min_non_empty_lines: -3 },
			tools: { ai: [] },
		});
		expect(result.config.llm.provider).toBe(DEFAULT_CONFIG.llm.provider);
		expect(result.config.llm.timeoutSeconds).toBe(
			DEFAULT_CONFIG.llm.timeoutSeconds,
		);
		expect(result.config.naming.maxLen).toBe(DEFAULT_CONFIG.naming.maxLen);
		expect(result.config.naming.minNonEmptyLines).toBe(
			DEFAULT_CONFIG.naming.minNonEmptyLines,
		);
		expect(result.config.tools.ai).toEqual([]);
		expect(result.warnings.length).toBeGreaterThanOrEqual(4);
	});

	test("LLM naming stays off when enabled is missing or invalid", () => {
		expect(decodeConfig({}).config.llm.enabled).toBe(false);
		const invalid = decodeConfig({ llm: { enabled: "yes" } });
		expect(invalid.config.llm.enabled).toBe(false);
		expect(invalid.warnings).toContain(
			"llm.enabled must be a boolean; using default",
		);
	});

	test("config paths honor XDG and permissions are private", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-config-"));
		try {
			const paths = configPaths({
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
			});
			ensureConfig(paths);
			expect(paths.configPath).toBe(
				join(root, "config", "tmux-autoname", "config.toml"),
			);
			expect(statSync(paths.configDir).mode & 0o777).toBe(0o700);
			expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);

			chmodSync(paths.configDir, 0o755);
			chmodSync(paths.configPath, 0o644);
			ensureConfig(paths);
			expect(statSync(paths.configDir).mode & 0o777).toBe(0o700);
			expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("relative XDG config paths are ignored", () => {
		expect(
			configPaths({ HOME: "/home/test", XDG_CONFIG_HOME: "relative" }),
		).toEqual({
			configDir: "/home/test/.config/tmux-autoname",
			configPath: "/home/test/.config/tmux-autoname/config.toml",
		});
	});
});
