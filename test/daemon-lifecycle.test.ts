import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity, run } from "../src/command.ts";
import {
	clearDaemonRecord,
	daemonLogPath,
	daemonEnvironment,
	expectedServer,
	flockCommand,
	prepareLockFile,
	readDaemonStatus,
	sameServer,
	serverRuntimeDir,
	writeDaemonRecord,
} from "../src/daemon-lifecycle.ts";
import type { TmuxAdapter } from "../src/tmux-adapter.ts";
import type {
	NameCandidate,
	PaneInfo,
	TmuxServerIdentity,
	WindowState,
} from "../src/types.ts";
import { currentUid } from "../src/runtime-paths.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

class OptionTmux implements TmuxAdapter {
	readonly options = new Map<string, string>();

	listActivePanes(): PaneInfo[] {
		return [];
	}
	readWindowState(): WindowState {
		return {
			managed: false,
			locked: false,
			manual: false,
			lastName: "",
			source: "",
			resetGeneration: "",
			resetPending: false,
		};
	}
	commitCandidate(
		_windowId: string,
		_expectedWindowName: string,
		_expectedResetGeneration: string,
		_candidate: NameCandidate,
	): boolean {
		return false;
	}
	markManual(): void {}
	clearWindowState(): void {}
	requestWindowReset(): void {}
	consumeWindowReset(): boolean {
		return false;
	}
	preserveManualWindowReset(): boolean {
		return false;
	}
	readWindowName(): string {
		return "tmux";
	}
	renameWindow(): void {}
	capturePane(): string[] {
		return [];
	}
	readGlobalOption(key: string): string {
		return this.options.get(key) ?? "";
	}
	setGlobalOption(key: string, value: string): void {
		this.options.set(key, value);
	}
	unsetGlobalOption(key: string): void {
		this.options.delete(key);
	}
	displayMessage(): void {}
	currentWindowId(): string {
		return "@1";
	}
	serverIdentity(): TmuxServerIdentity | null {
		return null;
	}
}

function server(
	overrides: Partial<TmuxServerIdentity> = {},
): TmuxServerIdentity {
	return {
		socketPath: "/tmp/tmux-1000/default",
		pid: 4242,
		startTicks: "123456",
		...overrides,
	};
}

const build = {
	codeVersion: "a".repeat(64),
	scriptPath: "/plugin/bin/tmux-autoname.ts",
};

describe("daemon lifecycle", () => {
	test("server equality includes socket, pid, and process start time", () => {
		const identity = server();
		expect(sameServer(identity, identity)).toBe(true);
		expect(sameServer(server({ pid: 4243 }), identity)).toBe(false);
		expect(sameServer(server({ startTicks: "123457" }), identity)).toBe(false);
		expect(sameServer(server({ socketPath: "/tmp/other" }), identity)).toBe(
			false,
		);
	});

	test("expected server identity round-trips through the child environment", () => {
		const identity = server();
		expect(expectedServer(daemonEnvironment(identity, {}))).toEqual(identity);
		expect(expectedServer({})).toBeNull();
	});

	test("lock paths are stable, private, and distinct per server", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-lock-"));
		temporaryPaths.push(root);
		const runtimeDir = join(root, "runtime");
		const first = prepareLockFile(runtimeDir, server());
		const repeated = prepareLockFile(runtimeDir, server());
		const second = prepareLockFile(runtimeDir, server({ pid: 4243 }));
		expect(first).toBe(repeated);
		expect(first).not.toBe(second);
		expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
		expect(statSync(first).mode & 0o777).toBe(0o600);
		expect(serverRuntimeDir(server())).toBe(
			`/tmp/tmux-1000/.tmux-autoname-${currentUid()}`,
		);
		expect(daemonLogPath("/state", server())).toMatch(
			/^\/state\/daemon-[a-f0-9]{64}\.log$/,
		);
		expect(daemonLogPath("/state", server())).not.toBe(
			daemonLogPath("/state", server({ pid: 4243 })),
		);
	});

	test("flock provides atomic exclusion for one server lock", async () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-flock-"));
		temporaryPaths.push(root);
		const lockPath = prepareLockFile(join(root, "runtime"), server());
		const holder = Bun.spawn([
			"flock",
			"--exclusive",
			"--nonblock",
			"--no-fork",
			lockPath,
			"sleep",
			"10",
		]);
		await Bun.sleep(30);
		const contender = run([
			"flock",
			"--exclusive",
			"--nonblock",
			lockPath,
			"true",
		]);
		expect(contender.exitCode).not.toBe(0);
		holder.kill("SIGTERM");
		await holder.exited;
	});

	test("daemon records require both server and process identity", () => {
		const tmux = new OptionTmux();
		const self = processIdentity(process.pid);
		expect(self).not.toBeNull();
		if (!self) return;

		const record = writeDaemonRecord(tmux, server(), self, build);
		expect(readDaemonStatus(tmux, server(), build)).toEqual({
			state: "running",
			record,
		});
		expect(
			readDaemonStatus(tmux, server({ socketPath: "/tmp/reused" }), build)
				.state,
		).toBe("stale");
		clearDaemonRecord(tmux, { ...record, startTicks: "1" });
		expect(tmux.options.get("@autoname_pid")).toBe(String(self.pid));
		clearDaemonRecord(tmux, record);
		expect(readDaemonStatus(tmux, server(), build).state).toBe("stopped");
	});

	test("running daemons become outdated when code or checkout changes", () => {
		const tmux = new OptionTmux();
		const self = processIdentity(process.pid);
		if (!self) throw new Error("missing process identity");
		writeDaemonRecord(tmux, server(), self, build);
		expect(
			readDaemonStatus(tmux, server(), {
				...build,
				codeVersion: "b".repeat(64),
			}).state,
		).toBe("outdated");
		expect(
			readDaemonStatus(tmux, server(), {
				...build,
				scriptPath: "/different/checkout.ts",
			}).state,
		).toBe("outdated");
	});

	test("foreground and background launch use nonblocking no-fork flock", () => {
		expect(flockCommand("/run/lock", "/usr/bin/bun", "/plugin/cli.ts")).toEqual(
			[
				"flock",
				"--exclusive",
				"--nonblock",
				"--conflict-exit-code",
				"75",
				"--no-fork",
				"/run/lock",
				"/usr/bin/bun",
				"/plugin/cli.ts",
				"_daemon",
			],
		);
		expect(
			flockCommand(
				"/run/lock",
				"/usr/bin/bun",
				"/plugin/cli.ts",
				"_once",
				["@1"],
			),
		).toEqual([
			"flock",
			"--exclusive",
			"--nonblock",
			"--conflict-exit-code",
			"75",
			"--no-fork",
			"/run/lock",
			"/usr/bin/bun",
			"/plugin/cli.ts",
			"_once",
			"@1",
		]);
	});
});
