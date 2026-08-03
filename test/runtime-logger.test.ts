import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_LOG_BYTES,
	MAX_DAEMON_LOG_FAMILIES,
	createRuntimeLogger,
	pruneDaemonLogs,
} from "../src/runtime-logger.ts";
import { runtimePaths } from "../src/runtime-paths.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("runtime paths and logger", () => {
	test("runtime paths honor XDG locations", () => {
		const paths = runtimePaths({
			HOME: "/home/test",
			XDG_STATE_HOME: "/state",
			XDG_RUNTIME_DIR: "/runtime",
		});
		expect(paths.stateDir).toBe("/state/tmux-autoname");
		expect(paths.logPath).toBe("/state/tmux-autoname/daemon.log");
	});

	test("relative XDG paths are ignored", () => {
		const paths = runtimePaths({
			HOME: "/home/test",
			XDG_STATE_HOME: "relative-state",
		});
		expect(paths.stateDir).toBe("/home/test/.local/state/tmux-autoname");
	});

	test("logger creates and hardens private files", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-log-"));
		temporaryPaths.push(root);
		const paths = runtimePaths({
			HOME: root,
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "runtime"),
		});
		const log = createRuntimeLogger(paths);
		log("hello");
		expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(paths.logPath).mode & 0o777).toBe(0o600);

		writeFileSync(paths.logPath, "old", { mode: 0o644 });
		chmodSync(paths.logPath, 0o644);
		log("again");
		expect(statSync(paths.logPath).mode & 0o777).toBe(0o600);
	});

	test("logger rotates at the configured bound and keeps one backup", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-rotate-"));
		temporaryPaths.push(root);
		const paths = runtimePaths({
			HOME: root,
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "runtime"),
		});
		const log = createRuntimeLogger(paths, { maxBytes: 256 });
		for (let index = 0; index < 20; index += 1) {
			log(`entry-${index}-${"x".repeat(40)}`);
		}
		expect(statSync(paths.logPath).size).toBeLessThanOrEqual(256);
		expect(statSync(`${paths.logPath}.1`).size).toBeLessThanOrEqual(256);
		expect(statSync(paths.logPath).mode & 0o777).toBe(0o600);
		expect(statSync(`${paths.logPath}.1`).mode & 0o777).toBe(0o600);
	});

	test("logger removes control characters from one-line records", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-control-"));
		temporaryPaths.push(root);
		const paths = runtimePaths({
			HOME: root,
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "runtime"),
		});
		createRuntimeLogger(paths)("first\nsecond\u0000third");
		const content = readFileSync(paths.logPath, "utf8");
		expect(content.trimEnd().split("\n")).toHaveLength(1);
		expect(content).not.toContain("\u0000");
	});

	test("production log bound is one MiB", () => {
		expect(MAX_LOG_BYTES).toBe(1024 * 1024);
	});

	test("old per-server log families are retained with a global bound", () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-retention-"));
		temporaryPaths.push(root);
		const stateDir = join(root, "state");
		const paths = runtimePaths({ HOME: root, XDG_STATE_HOME: stateDir });
		createRuntimeLogger(paths)("create directory");
		for (let index = 0; index < 12; index += 1) {
			const key = index.toString(16).padStart(64, "0");
			writeFileSync(join(paths.stateDir, `daemon-${key}.log`), "log");
			writeFileSync(join(paths.stateDir, `daemon-${key}.log.1`), "backup");
		}
		const activeKey = "f".repeat(64);
		const active = join(paths.stateDir, `daemon-${activeKey}.log`);
		pruneDaemonLogs(paths.stateDir, active);
		const retained = readdirSync(paths.stateDir).filter((entry) =>
			/^daemon-[a-f0-9]{64}\.log(?:\.1)?$/.test(entry),
		);
		expect(new Set(retained.map((entry) => entry.slice(0, 71))).size).toBe(
			MAX_DAEMON_LOG_FAMILIES - 1,
		);
	});

	test("concurrent server log pruning tolerates disappearing files", async () => {
		const root = mkdtempSync(join(tmpdir(), "tmux-autoname-prune-race-"));
		temporaryPaths.push(root);
		const paths = runtimePaths({
			HOME: root,
			XDG_STATE_HOME: join(root, "state"),
		});
		createRuntimeLogger(paths)("create directory");
		const activePaths: string[] = [];
		for (let index = 0; index < 200; index += 1) {
			const key = index.toString(16).padStart(64, "0");
			const logPath = join(paths.stateDir, `daemon-${key}.log`);
			writeFileSync(logPath, "log");
			writeFileSync(`${logPath}.1`, "backup");
			if (index < 24) activePaths.push(logPath);
		}
		const gate = join(root, "start-pruning");
		const moduleUrl = new URL("../src/runtime-logger.ts", import.meta.url).href;
		const workerSource = `
import { existsSync, writeFileSync } from "node:fs";
import { pruneDaemonLogs } from ${JSON.stringify(moduleUrl)};
writeFileSync(process.argv[3], "ready");
while (!existsSync(process.argv[4])) await Bun.sleep(1);
pruneDaemonLogs(process.argv[1], process.argv[2]);
`;
		const workers = activePaths.map((activePath, index) => {
			const ready = join(root, `ready-${index}`);
			return {
				ready,
				proc: Bun.spawn(
					[
						process.execPath,
						"-e",
						workerSource,
						paths.stateDir,
						activePath,
						ready,
						gate,
					],
					{ stdout: "ignore", stderr: "pipe" },
				),
			};
		});
		for (let attempt = 0; attempt < 300; attempt += 1) {
			if (workers.every(({ ready }) => existsSync(ready))) break;
			await Bun.sleep(10);
		}
		expect(workers.every(({ ready }) => existsSync(ready))).toBe(true);
		writeFileSync(gate, "start");
		const results = await Promise.all(
			workers.map(async ({ proc }) => {
				const [exitCode, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stderr).text(),
				]);
				return { exitCode, stderr };
			}),
		);
		expect(results.filter(({ exitCode }) => exitCode !== 0)).toEqual([]);
		expect(results.every(({ stderr }) => stderr === "")).toBe(true);
	});
});
