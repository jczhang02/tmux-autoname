import { basename } from "node:path";
import { commandKey, splitShellish, type CommandRunner } from "./command.ts";
import { clampName, stripTestPath } from "./naming-utils.ts";
import type { Config, NameCandidate, PaneInfo, ProcInfo } from "./types.ts";

export function heuristicCandidate(
	pane: PaneInfo,
	proc: ProcInfo | null,
	config: Config,
	run: CommandRunner,
): NameCandidate | null {
	const procCommand = commandKey(proc?.comm ?? pane.paneCommand);
	const paneCommand = commandKey(pane.paneCommand);
	const tool = procCommand || paneCommand;
	const args = splitShellish(proc?.args ?? pane.paneCommand);

	if (config.tools.editors.includes(tool)) {
		return {
			tool,
			source: "editor",
			lock: false,
			name: clampName(
				tool,
				editorTarget(
					proc ?? { pid: 0, ppid: 0, comm: tool, args: tool },
					pane,
					run,
				),
				config.naming.maxLen,
			),
		};
	}

	if (tool === "pytest" || args.includes("pytest")) {
		const pytestIndex = args.findIndex((arg) => arg === "pytest");
		const pytestArgs =
			pytestIndex >= 0 ? args.slice(pytestIndex + 1) : args.slice(1);
		return {
			tool: "pytest",
			source: "test",
			lock: false,
			name: clampName("pytest", testTarget(pytestArgs), config.naming.maxLen),
		};
	}

	if (tool === "cargo") {
		const subcommand =
			args.find((arg, index) => index > 0 && !arg.startsWith("-")) ?? "cargo";
		return {
			tool: "cargo",
			source: "build",
			lock: false,
			name: clampName("cargo", subcommand, config.naming.maxLen),
		};
	}

	if (["bun", "npm", "pnpm"].includes(tool)) {
		const sub = args[1] === "run" ? args[2] : args[1];
		if (sub)
			return {
				tool,
				source: "build",
				lock: false,
				name: clampName(tool, sub, config.naming.maxLen),
			};
	}

	if (tool === "uv") {
		const runIndex = args.findIndex((arg) => arg === "run");
		const runTool =
			runIndex >= 0 ? commandKey(args[runIndex + 1] ?? "run") : "uv";
		if (runTool === "pytest")
			return {
				tool: "pytest",
				source: "test",
				lock: false,
				name: clampName(
					"pytest",
					testTarget(args.slice(runIndex + 2)),
					config.naming.maxLen,
				),
			};
		return {
			tool: "uv",
			source: "build",
			lock: false,
			name: clampName("uv", runTool, config.naming.maxLen),
		};
	}

	if (
		config.tools.shells.includes(tool) ||
		config.tools.shells.includes(paneCommand)
	) {
		return {
			tool: "shell",
			source: "shell",
			lock: false,
			name: clampName(
				"shell",
				gitRootName(pane.panePath, run),
				config.naming.maxLen,
			),
		};
	}

	return null;
}

export function gitRootName(cwd: string, run: CommandRunner): string {
	const result = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.exitCode === 0) return basename(result.stdout.trim());
	return basename(cwd);
}

export function testTarget(args: string[]): string {
	const kIndex = args.findIndex((arg) => arg === "-k");
	if (kIndex >= 0 && args[kIndex + 1]) return args[kIndex + 1] ?? "test";
	const path = firstPathLike(args);
	if (path) return stripTestPath(path);
	return "test";
}

export function editorTarget(
	proc: ProcInfo,
	pane: PaneInfo,
	run: CommandRunner,
): string {
	const args = splitShellish(proc.args)
		.slice(1)
		.filter((arg) => !arg.startsWith("-"));
	const fileArg = args.find((arg) => arg.length > 0);
	if (fileArg) return basename(fileArg).replace(/^term:\/\//, "");
	const title = pane.paneTitle.trim();
	if (
		title &&
		!/^tmux/i.test(title) &&
		commandKey(title) !== commandKey(proc.comm)
	)
		return basename(title);
	return gitRootName(pane.panePath, run);
}

function firstPathLike(args: string[]): string | null {
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		if (arg.includes("/") || /\.[a-z0-9]+$/i.test(arg)) return arg;
	}
	return null;
}
