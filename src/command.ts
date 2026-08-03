import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type {
	CommandOptions,
	CommandResult,
	ProcessIdentity,
} from "./types.ts";

const textDecoder = new TextDecoder();

export type CommandRunner = (
	args: string[],
	stdin?: string,
	env?: NodeJS.ProcessEnv,
	options?: CommandOptions,
) => CommandResult;

export type AsyncCommandRunner = (
	args: string[],
	stdin?: string,
	env?: NodeJS.ProcessEnv,
	options?: CommandOptions,
) => Promise<CommandResult>;

export const run: CommandRunner = (
	args: string[],
	stdin?: string,
	env?: NodeJS.ProcessEnv,
	options?: CommandOptions,
): CommandResult => {
	const proc = Bun.spawnSync(args, {
		stdin: stdin === undefined ? undefined : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? process.env,
		maxBuffer: options?.maxBuffer,
		timeout: options?.timeoutMs,
	});
	const stdout = options?.maxBuffer
		? proc.stdout.subarray(0, options.maxBuffer)
		: proc.stdout;
	const stderr = options?.maxBuffer
		? proc.stderr.subarray(0, options.maxBuffer)
		: proc.stderr;
	return {
		stdout: textDecoder.decode(stdout),
		stderr: textDecoder.decode(stderr),
		exitCode: proc.exitCode,
	};
};

export const runAsync: AsyncCommandRunner = async (
	args: string[],
	stdin?: string,
	env?: NodeJS.ProcessEnv,
	options?: CommandOptions,
): Promise<CommandResult> => {
	const proc = Bun.spawn(args, {
		stdin: stdin === undefined ? undefined : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? process.env,
		maxBuffer: options?.maxBuffer,
		signal: options?.signal,
		timeout: options?.timeoutMs,
	});
	const [exitCode, stdoutBuffer, stderrBuffer] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
	]);
	const stdoutBytes = new Uint8Array(stdoutBuffer);
	const stderrBytes = new Uint8Array(stderrBuffer);
	const stdout = options?.maxBuffer
		? stdoutBytes.subarray(0, options.maxBuffer)
		: stdoutBytes;
	const stderr = options?.maxBuffer
		? stderrBytes.subarray(0, options.maxBuffer)
		: stderrBytes;
	return {
		stdout: textDecoder.decode(stdout),
		stderr: textDecoder.decode(stderr),
		exitCode,
	};
};

export function commandKey(input: string): string {
	const base = basename(input).toLowerCase().trim();
	if (base === "π" || base.startsWith("π:")) return "pi";
	if (/^\d+\.\d+(\.\d+)?$/.test(base)) return "claude";
	if (base === "claude-code") return "claude";
	return base;
}

export function splitShellish(input: string): string[] {
	return input.split(/\s+/).filter(Boolean);
}

export function processStartTicks(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 1) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
		const startTicks = fieldsAfterCommand[19];
		return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
	} catch {
		return null;
	}
}

export function processIdentity(pid: number): ProcessIdentity | null {
	const startTicks = processStartTicks(pid);
	return startTicks ? { pid, startTicks } : null;
}

export function processMatches(identity: ProcessIdentity): boolean {
	return processStartTicks(identity.pid) === identity.startTicks;
}
