import { commandKey, type AsyncCommandRunner } from "./command.ts";
import { clampName, slugify } from "./naming-utils.ts";
import type {
	Config,
	Logger,
	NameCandidate,
	PaneInfo,
	ProcInfo,
} from "./types.ts";

export interface ContentSample {
	sample: string;
	nonEmptyCount: number;
}

export const MAX_SAMPLE_BYTES = 64 * 1024;
const MAX_PROVIDER_OUTPUT_BYTES = 128 * 1024;

export interface LlmSlugRequest {
	tool: string;
	pane: PaneInfo;
	content: string;
	config: Config;
	signal?: AbortSignal;
}

export interface LlmSlugAdapter {
	generateSlug(request: LlmSlugRequest): Promise<string | null>;
}

export function detectAiTool(
	pane: PaneInfo,
	proc: ProcInfo | null,
	config: Config,
): string | null {
	const candidates = [
		pane.paneCommand,
		proc?.comm ?? "",
		proc?.args.split(/\s+/)[0] ?? "",
	].map(commandKey);
	for (const candidate of candidates) {
		if (config.tools.ai.includes(candidate)) return candidate;
	}
	return null;
}

export function contentAfterHeader(lines: string[], tool: string): string[] {
	const patterns =
		tool === "claude"
			? [/Claude Code v\d+/i, /Welcome to Claude Code/i]
			: [
					/\bpi\b.*AI coding assistant/i,
					/Startup header/i,
					/Current working directory:/i,
				];

	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (patterns.some((pattern) => pattern.test(lines[index] ?? "")))
			start = index;
	}
	return start >= 0 ? lines.slice(start + 1) : lines;
}

export function sampleContent(lines: string[], config: Config): ContentSample {
	const cleaned = lines.map((line) =>
		line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd(),
	);
	const nonEmpty = cleaned.filter((line) => line.trim().length > 0);
	const head = cleaned.slice(0, config.naming.headLines);
	const tail = cleaned.slice(
		Math.max(config.naming.headLines, cleaned.length - config.naming.tailLines),
	);
	const omitted = cleaned.length - head.length - tail.length;
	const fullSample =
		omitted > 0
			? `${head.join("\n")}\n\n[...${omitted} lines omitted...]\n\n${tail.join("\n")}`
			: cleaned.join("\n");
	const bytes = Buffer.from(fullSample, "utf8");
	let sample =
		bytes.byteLength > MAX_SAMPLE_BYTES
			? bytes.subarray(0, MAX_SAMPLE_BYTES).toString("utf8")
			: fullSample;
	while (Buffer.byteLength(sample, "utf8") > MAX_SAMPLE_BYTES) {
		sample = sample.slice(0, -1);
	}
	return { sample, nonEmptyCount: nonEmpty.length };
}

export function buildNamingPrompt(
	tool: string,
	pane: PaneInfo,
	content: string,
	maxSlugLen: number,
): string {
	return `Generate a stable tmux window work slug for this ${tool} coding-agent terminal.

Rules:
- Output exactly one ASCII lowercase kebab-case slug.
- No tool prefix. No quotes. No explanation.
- Max ${maxSlugLen} characters.
- Prefer stable project/domain/task identity over the latest short instruction.
- Keep recurring domain words (mri, tmux, auth, payment, classifier, plugin).
- Do not repeat the tool/harness name (${tool}, pi, claude, coding-agent) in the slug.
- Avoid generic-only names like exp, work, fix, update, test, task, agent, assistant.
- If the content mentions a created subfolder or repeatedly used project path, prefer that over the launch cwd.

Launch cwd: ${pane.panePath}
Current tmux window name: ${pane.windowName}

Terminal content:
${content}`;
}

export function cleanAiSlug(raw: string, tool: string): string | null {
	const generic = new Set([
		tool,
		"pi",
		"claude",
		"coding",
		"agent",
		"assistant",
		"terminal",
	]);
	const words = slugify(raw, "")
		.split("-")
		.filter((word) => word.length > 0 && !generic.has(word));
	return words.length > 0 ? words.join("-") : null;
}

export async function createAiCandidate(
	pane: PaneInfo,
	tool: string,
	rawLines: string[],
	config: Config,
	llm: LlmSlugAdapter,
	log: Logger,
	signal?: AbortSignal,
): Promise<NameCandidate | null> {
	const contentLines = contentAfterHeader(rawLines, tool);
	const { sample, nonEmptyCount } = sampleContent(contentLines, config);
	if (nonEmptyCount < config.naming.minNonEmptyLines) {
		log(`skip ${pane.windowId} ${tool}: only ${nonEmptyCount} content lines`);
		return null;
	}

	const slug = await llm.generateSlug({
		tool,
		pane,
		content: sample,
		config,
		signal,
	});
	if (!slug) return null;
	return {
		tool,
		source: "ai",
		lock: true,
		name: clampName(tool, slug, config.naming.maxLen),
	};
}

export class PiCliLlmAdapter implements LlmSlugAdapter {
	constructor(
		private readonly run: AsyncCommandRunner,
		private readonly log: Logger,
	) {}

	async generateSlug(request: LlmSlugRequest): Promise<string | null> {
		const maxSlugLen = Math.max(
			4,
			request.config.naming.maxLen - request.tool.length - 1,
		);
		const systemPrompt = `You name tmux windows. Return one ASCII lowercase kebab-case slug only, max ${maxSlugLen} characters. Do not include tool names like pi, claude, coding-agent, or assistant. No quotes. No markdown.`;
		const prompt = buildNamingPrompt(
			request.tool,
			request.pane,
			request.content,
			maxSlugLen,
		);
		const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
		const result = await this.run(
			[
				"pi",
				"--provider",
				request.config.llm.provider,
				"--model",
				request.config.llm.model,
				"-p",
				"--no-tools",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--thinking",
				request.config.llm.thinking,
				"--models",
				`${request.config.llm.provider}/*`,
				"--system-prompt",
				systemPrompt,
			],
			prompt,
			env,
			{
				maxBuffer: MAX_PROVIDER_OUTPUT_BYTES,
				signal: request.signal,
				timeoutMs: request.config.llm.timeoutSeconds * 1000,
			},
		);

		if (result.exitCode !== 0) {
			if (request.signal?.aborted) return null;
			this.log(
				`pi naming failed for ${request.pane.windowId}: provider=${request.config.llm.provider} exit=${result.exitCode} stderr_bytes=${Buffer.byteLength(result.stderr, "utf8")}`,
			);
			return null;
		}

		const firstLine = result.stdout
			.split("\n")
			.map((line) =>
				line
					.trim()
					.replace(/^`+|`+$/g, "")
					.replace(/^[']|[']$/g, "")
					.replace(/^["]|["]$/g, ""),
			)
			.find((line) => line.length > 0);
		if (!firstLine) return null;
		const cleaned = cleanAiSlug(firstLine, request.tool);
		if (!cleaned) {
			this.log(`pi naming returned an invalid slug for ${request.pane.windowId}`);
			return null;
		}
		return cleaned;
	}
}
