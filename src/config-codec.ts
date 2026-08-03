import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { commandKey } from "./command.ts";
import type { Config, Logger } from "./types.ts";

export interface ConfigPaths {
	configDir: string;
	configPath: string;
}

export interface ConfigDecodeResult {
	config: Config;
	warnings: string[];
}

export const DEFAULT_CONFIG: Config = {
	llm: {
		enabled: false,
		provider: "openai-codex",
		model: "gpt-5.4-mini",
		thinking: "off",
		timeoutSeconds: 45,
	},
	naming: {
		maxLen: 24,
		pollSeconds: 30,
		minNonEmptyLines: 5,
		headLines: 120,
		tailLines: 120,
	},
	tools: {
		ai: ["pi", "claude"],
		shells: ["bash", "zsh", "fish", "sh"],
		editors: ["nvim", "vim", "vi"],
	},
};

export function configPaths(
	env: NodeJS.ProcessEnv = process.env,
): ConfigPaths {
	const requestedHome = env.HOME?.trim();
	const home = requestedHome && isAbsolute(requestedHome) ? requestedHome : homedir();
	const requestedConfigHome = env.XDG_CONFIG_HOME?.trim();
	const configHome =
		requestedConfigHome && isAbsolute(requestedConfigHome)
			? requestedConfigHome
			: join(home, ".config");
	const configDir = join(configHome, "tmux-autoname");
	return { configDir, configPath: join(configDir, "config.toml") };
}

export function defaultConfigToml(config: Config = DEFAULT_CONFIG): string {
	return `# LLM naming is opt-in because it sends terminal data to a provider.
# There is no automatic secret redaction. Read README.md before enabling it.
[llm]
enabled = ${config.llm.enabled}
provider = "${config.llm.provider}"
model = "${config.llm.model}"
thinking = "${config.llm.thinking}"
timeout_seconds = ${config.llm.timeoutSeconds}

[naming]
max_len = ${config.naming.maxLen}
poll_seconds = ${config.naming.pollSeconds}
min_non_empty_lines = ${config.naming.minNonEmptyLines}
head_lines = ${config.naming.headLines}
tail_lines = ${config.naming.tailLines}

[tools]
ai = ${tomlStringArray(config.tools.ai)}
shells = ${tomlStringArray(config.tools.shells)}
editors = ${tomlStringArray(config.tools.editors)}
`;
}

export function ensureConfig(paths: ConfigPaths, log?: Logger): void {
	mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
	if (!statSync(paths.configDir).isDirectory()) {
		throw new Error(`config path is not a directory: ${paths.configDir}`);
	}
	chmodSync(paths.configDir, 0o700);
	if (existsSync(paths.configPath)) {
		if (!statSync(paths.configPath).isFile()) {
			throw new Error(`config path is not a regular file: ${paths.configPath}`);
		}
		chmodSync(paths.configPath, 0o600);
		return;
	}
	writeFileSync(paths.configPath, defaultConfigToml(), { mode: 0o600 });
	chmodSync(paths.configPath, 0o600);
	log?.(`created default config ${paths.configPath}`);
}

export function readConfig(
	paths: ConfigPaths,
	log?: Logger,
): ConfigDecodeResult {
	ensureConfig(paths, log);
	const parser = (Bun as unknown as { TOML: { parse(input: string): unknown } })
		.TOML;
	const parsed = parser.parse(readFileSync(paths.configPath, "utf8"));
	return decodeConfig(parsed);
}

export function decodeConfig(raw: unknown): ConfigDecodeResult {
	const warnings: string[] = [];
	const root = isRecord(raw) ? raw : warnRecord(warnings, "root", {});
	const llm = section(root, "llm", warnings);
	const naming = section(root, "naming", warnings);
	const tools = section(root, "tools", warnings);

	return {
		warnings,
		config: {
			llm: {
				enabled: booleanValue(
					llm.enabled,
					DEFAULT_CONFIG.llm.enabled,
					"llm.enabled",
					warnings,
				),
				provider: stringValue(
					llm.provider,
					DEFAULT_CONFIG.llm.provider,
					"llm.provider",
					warnings,
				),
				model: stringValue(
					llm.model,
					DEFAULT_CONFIG.llm.model,
					"llm.model",
					warnings,
				),
				thinking: stringValue(
					llm.thinking,
					DEFAULT_CONFIG.llm.thinking,
					"llm.thinking",
					warnings,
				),
				timeoutSeconds: positiveNumberValue(
					llm.timeout_seconds,
					DEFAULT_CONFIG.llm.timeoutSeconds,
					"llm.timeout_seconds",
					warnings,
				),
			},
			naming: {
				maxLen: positiveNumberValue(
					naming.max_len,
					DEFAULT_CONFIG.naming.maxLen,
					"naming.max_len",
					warnings,
				),
				pollSeconds: positiveNumberValue(
					naming.poll_seconds,
					DEFAULT_CONFIG.naming.pollSeconds,
					"naming.poll_seconds",
					warnings,
				),
				minNonEmptyLines: nonNegativeNumberValue(
					naming.min_non_empty_lines,
					DEFAULT_CONFIG.naming.minNonEmptyLines,
					"naming.min_non_empty_lines",
					warnings,
				),
				headLines: nonNegativeNumberValue(
					naming.head_lines,
					DEFAULT_CONFIG.naming.headLines,
					"naming.head_lines",
					warnings,
				),
				tailLines: nonNegativeNumberValue(
					naming.tail_lines,
					DEFAULT_CONFIG.naming.tailLines,
					"naming.tail_lines",
					warnings,
				),
			},
			tools: {
				ai: stringArray(
					tools.ai,
					DEFAULT_CONFIG.tools.ai,
					"tools.ai",
					warnings,
				).map(commandKey),
				shells: stringArray(
					tools.shells,
					DEFAULT_CONFIG.tools.shells,
					"tools.shells",
					warnings,
				).map(commandKey),
				editors: stringArray(
					tools.editors,
					DEFAULT_CONFIG.tools.editors,
					"tools.editors",
					warnings,
				).map(commandKey),
			},
		},
	};
}

function tomlStringArray(values: string[]): string {
	return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnRecord(
	warnings: string[],
	path: string,
	fallback: Record<string, unknown>,
): Record<string, unknown> {
	warnings.push(`${path} must be a table; using defaults`);
	return fallback;
}

function section(
	root: Record<string, unknown>,
	key: string,
	warnings: string[],
): Record<string, unknown> {
	const value = root[key];
	if (value === undefined) return {};
	if (isRecord(value)) return value;
	warnings.push(`${key} must be a table; using defaults for ${key}`);
	return {};
}

function stringValue(
	value: unknown,
	fallback: string,
	path: string,
	warnings: string[],
): string {
	if (typeof value === "string" && value.trim().length > 0) return value;
	if (value !== undefined)
		warnings.push(`${path} must be a non-empty string; using default`);
	return fallback;
}

function booleanValue(
	value: unknown,
	fallback: boolean,
	path: string,
	warnings: string[],
): boolean {
	if (typeof value === "boolean") return value;
	if (value !== undefined)
		warnings.push(`${path} must be a boolean; using default`);
	return fallback;
}

function positiveNumberValue(
	value: unknown,
	fallback: number,
	path: string,
	warnings: string[],
): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0)
		return value;
	if (value !== undefined)
		warnings.push(`${path} must be a positive number; using default`);
	return fallback;
}

function nonNegativeNumberValue(
	value: unknown,
	fallback: number,
	path: string,
	warnings: string[],
): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0)
		return value;
	if (value !== undefined)
		warnings.push(`${path} must be a non-negative number; using default`);
	return fallback;
}

function stringArray(
	value: unknown,
	fallback: string[],
	path: string,
	warnings: string[],
): string[] {
	if (!Array.isArray(value)) {
		if (value !== undefined)
			warnings.push(`${path} must be a string array; using default`);
		return fallback;
	}
	if (value.length === 0) return [];
	const out = value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim().length > 0,
	);
	if (out.length > 0) return out;
	warnings.push(`${path} has no valid strings; using default`);
	return fallback;
}
