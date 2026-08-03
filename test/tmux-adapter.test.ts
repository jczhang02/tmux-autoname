import { describe, expect, test } from "bun:test";
import { TmuxCliAdapter } from "../src/tmux-adapter.ts";
import type { CommandResult } from "../src/types.ts";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
	return { stdout, stderr, exitCode };
}

describe("TmuxAdapter", () => {
	test("listActivePanes parses only active panes", () => {
		const adapter = new TmuxCliAdapter((args) => {
			expect(args.slice(0, 3)).toEqual(["tmux", "list-panes", "-a"]);
			return result(
				[
					"main\t@1\t1\ttmux\t%1\t1\tpi\t/repo\t100\tπ title",
					"main\t@1\t1\ttmux\t%2\t0\tzsh\t/repo\t101\tinactive",
				].join("\n"),
			);
		});
		expect(adapter.listActivePanes()).toEqual([
			{
				sessionName: "main",
				windowId: "@1",
				windowIndex: "1",
				windowName: "tmux",
				paneId: "%1",
				paneActive: true,
				paneCommand: "pi",
				panePath: "/repo",
				panePid: 100,
				paneTitle: "π title",
			},
		]);
	});

	test("readWindowState parses tmux user options", () => {
		const adapter = new TmuxCliAdapter(() =>
			result(
				[
					"@autoname_managed 1",
					"@autoname_locked 1",
					"@autoname_last_name pi:tmux-plugin",
					"@autoname_source ai",
					"@autoname_reset_generation reset-2",
					"@autoname_reset_pending 1",
				].join("\n"),
			),
		);
		expect(adapter.readWindowState("@1")).toEqual({
			managed: true,
			locked: true,
			manual: false,
			lastName: "pi:tmux-plugin",
			source: "ai",
			resetGeneration: "reset-2",
			resetPending: true,
		});
	});

	test("clearWindowState invalidates an in-flight naming result", () => {
		const calls: string[][] = [];
		const adapter = new TmuxCliAdapter((args) => {
			calls.push(args);
			return result();
		});
		adapter.clearWindowState("@1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 6)).toEqual([
			"tmux",
			"set-option",
			"-wq",
			"-t",
			"@1",
			"@autoname_reset_generation",
		]);
		expect(calls[0]?.[6]).toMatch(/^[a-f0-9-]{36}$/);
		const command = calls[0] ?? [];
		let cursor = 7;
		for (const key of [
			"@autoname_managed",
			"@autoname_locked",
			"@autoname_manual",
			"@autoname_last_name",
			"@autoname_source",
			"@autoname_reset_pending",
		]) {
			expect(command.slice(cursor, cursor + 7)).toEqual([
				";",
				"set-option",
				"-wq",
				"-u",
				"-t",
				"@1",
				key,
			]);
			cursor += 7;
		}
		expect(cursor).toBe(command.length);
	});

	test("requestWindowReset invalidates first and leaves a pending marker", () => {
		const calls: string[][] = [];
		const adapter = new TmuxCliAdapter((args) => {
			calls.push(args);
			return result();
		});
		adapter.requestWindowReset("@1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 6)).toEqual([
			"tmux",
			"set-option",
			"-wq",
			"-t",
			"@1",
			"@autoname_reset_generation",
		]);
		expect(calls[0]?.[6]).toMatch(/^[a-f0-9-]{36}$/);
		const command = calls[0] ?? [];
		expect(command.slice(7, 12)).toEqual([
			";",
			"rename-window",
			"-t",
			"@1",
			"tmux",
		]);
		const pendingIndex = command.lastIndexOf("@autoname_reset_pending");
		for (const key of [
			"@autoname_managed",
			"@autoname_locked",
			"@autoname_manual",
			"@autoname_last_name",
			"@autoname_source",
		]) {
			expect(command.indexOf(key)).toBeGreaterThan(11);
			expect(command.indexOf(key)).toBeLessThan(pendingIndex);
		}
		expect(command.slice(-7)).toEqual([
			";",
			"set-option",
			"-wq",
			"-t",
			"@1",
			"@autoname_reset_pending",
			"1",
		]);
	});

	test("preserveManualWindowReset conditionally cancels the reset", () => {
		const calls: string[][] = [];
		const adapter = new TmuxCliAdapter((args) => {
			calls.push(args);
			return result("TMUX_AUTONAME_CAS_APPLIED\n");
		});
		expect(
			adapter.preserveManualWindowReset("@1", "my manual name", "reset-2"),
		).toBe(true);
		expect(calls).toHaveLength(1);
		const command = calls[0] ?? [];
		expect(command.slice(0, 7)).toEqual([
			"tmux",
			"set-option",
			"-wq",
			"-t",
			"@1",
			"@autoname_cas_expected_name",
			"my manual name",
		]);
		const conditionalIndex = command.indexOf("if-shell");
		expect(conditionalIndex).toBeGreaterThan(0);
		expect(command[conditionalIndex + 5]).toContain(
			"set-option -wq -u -t @1 @autoname_reset_pending",
		);
		expect(command[conditionalIndex + 5]).toContain(
			"set-option -wq -t @1 @autoname_manual 1",
		);
	});

	test("commitCandidate conditionally writes the name and window state", () => {
		const calls: string[][] = [];
		const adapter = new TmuxCliAdapter((args) => {
			calls.push(args);
			return result("TMUX_AUTONAME_CAS_APPLIED\n");
		});
		expect(
			adapter.commitCandidate("@1", "tmux", "reset-2", {
				name: "pi:tmux-plugin",
				tool: "pi",
				source: "ai",
				lock: true,
			}),
		).toBe(true);
		expect(calls).toHaveLength(1);
		const command = calls[0] ?? [];
		const conditionalIndex = command.indexOf("if-shell");
		expect(conditionalIndex).toBeGreaterThan(0);
		const appliedCommands = command[conditionalIndex + 5] ?? "";
		expect(appliedCommands).toContain(
			"rename-window -t @1 pi:tmux-plugin",
		);
		expect(appliedCommands).toContain(
			"set-option -wq -t @1 @autoname_managed 1",
		);
		expect(appliedCommands).toContain(
			"set-option -wq -t @1 @autoname_last_name pi:tmux-plugin",
		);
		expect(appliedCommands).toContain(
			"set-option -wq -t @1 @autoname_source ai",
		);
		expect(appliedCommands).toContain(
			"set-option -wq -t @1 @autoname_locked 1",
		);
	});

	test("commitCandidate reports a skipped conditional update", () => {
		const adapter = new TmuxCliAdapter(() =>
			result("TMUX_AUTONAME_CAS_SKIPPED\n"),
		);
		expect(
			adapter.commitCandidate("@1", "stale-name", "reset-2", {
				name: "shell:repo",
				tool: "shell",
				source: "shell",
				lock: false,
			}),
		).toBe(false);
	});

	test("readWindowName reads the live name for a race check", () => {
		const adapter = new TmuxCliAdapter((args) => {
			expect(args).toEqual([
				"tmux",
				"display-message",
				"-p",
				"-t",
				"@1",
				"#{window_name}",
			]);
			return result("manual-name\n");
		});
		expect(adapter.readWindowName("@1")).toBe("manual-name");
	});

	test("capturePane uses joined capture command", () => {
		const calls: string[][] = [];
		const adapter = new TmuxCliAdapter((args) => {
			calls.push(args);
			return result("line1\nline2\n");
		});
		expect(adapter.capturePane("%1")).toEqual(["line1", "line2", ""]);
		expect(calls[0]).toEqual([
			"tmux",
			"capture-pane",
			"-pJ",
			"-t",
			"%1",
			"-S",
			"-1000",
		]);
	});

	test("serverIdentity includes socket, pid, and process start ticks", () => {
		const adapter = new TmuxCliAdapter(
			(args) => {
				expect(args).toEqual([
					"tmux",
					"display-message",
					"-p",
					"#{socket_path}\t#{pid}",
				]);
				return result("/tmp/tmux-1000/default\t4242\n");
			},
			(pid) => (pid === 4242 ? "123456" : null),
		);
		expect(adapter.serverIdentity()).toEqual({
			socketPath: "/tmp/tmux-1000/default",
			pid: 4242,
			startTicks: "123456",
		});
	});
});
