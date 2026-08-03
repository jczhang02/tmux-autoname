import { describe, expect, test } from "bun:test";
import {
	readProcessSnapshot,
	resolveActiveProcess,
	type ProcessSnapshot,
} from "../src/process-tree-resolver.ts";
import type { CommandResult, ProcInfo } from "../src/types.ts";
import { pane, testConfig } from "./helpers.ts";

function snapshot(processes: ProcInfo[]): ProcessSnapshot {
	return new Map(processes.map((proc) => [proc.pid, proc]));
}

describe("ProcessTreeResolver", () => {
	test("readProcessSnapshot parses ps output", () => {
		const table = readProcessSnapshot(
			(): CommandResult => ({
				stdout: "  10  1 zsh zsh\n  11 10 pi pi --flag\n",
				stderr: "",
				exitCode: 0,
			}),
		);
		expect(table.get(10)).toEqual({
			pid: 10,
			ppid: 1,
			comm: "zsh",
			args: "zsh",
		});
		expect(table.get(11)).toEqual({
			pid: 11,
			ppid: 10,
			comm: "pi",
			args: "pi --flag",
		});
	});

	test("matching pane command wins over shallower shell", () => {
		const active = resolveActiveProcess(
			pane({ panePid: 10, paneCommand: "pi" }),
			snapshot([
				{ pid: 10, ppid: 1, comm: "zsh", args: "zsh" },
				{ pid: 11, ppid: 10, comm: "pi", args: "pi" },
			]),
			testConfig(),
		);
		expect(active?.comm).toBe("pi");
	});

	test("deepest non-shell process wins for nested uv run pytest", () => {
		const active = resolveActiveProcess(
			pane({ panePid: 10, paneCommand: "zsh" }),
			snapshot([
				{ pid: 10, ppid: 1, comm: "zsh", args: "zsh" },
				{
					pid: 11,
					ppid: 10,
					comm: "uv",
					args: "uv run pytest tests/test_auth.py",
				},
				{
					pid: 12,
					ppid: 11,
					comm: "pytest",
					args: "pytest tests/test_auth.py",
				},
			]),
			testConfig(),
		);
		expect(active?.comm).toBe("pytest");
	});

	test("tmux child is ignored before falling back to shell", () => {
		const active = resolveActiveProcess(
			pane({ panePid: 10, paneCommand: "zsh" }),
			snapshot([
				{ pid: 10, ppid: 1, comm: "zsh", args: "zsh" },
				{ pid: 11, ppid: 10, comm: "tmux", args: "tmux" },
			]),
			testConfig(),
		);
		expect(active?.comm).toBe("zsh");
	});
});
