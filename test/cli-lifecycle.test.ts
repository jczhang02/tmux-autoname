import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	defaultConfigToml,
} from "../src/config-codec.ts";

const projectRoot = join(import.meta.dir, "..");
const cliPath = join(projectRoot, "bin", "tmux-autoname.ts");
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface TestServer {
	env: NodeJS.ProcessEnv;
	label: string;
	pid: number;
	root: string;
	socketPath: string;
}

function createServer(): TestServer {
	const root = mkdtempSync(join(tmpdir(), "tmux-autoname-cli-"));
	const label = `autoname-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const socketRoot = join(root, "sockets");
	mkdirSync(socketRoot, { mode: 0o700 });
	const serverEnv: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: socketRoot,
	};
	delete serverEnv.TMUX;
	const created = Bun.spawnSync(
		["tmux", "-L", label, "-f", "/dev/null", "new-session", "-d", "-s", "test"],
		{ env: serverEnv },
	);
	if (created.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(created.stderr));
	}
	const identity = tmux(
		label,
		serverEnv,
		["display-message", "-p", "#{socket_path}|#{pid}"],
	).trim();
	const [socketPath = "", pidText = ""] = identity.split("|");
	const pid = Number(pidText);
	const configDir = join(root, "config", "tmux-autoname");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.toml"),
		defaultConfigToml(DEFAULT_CONFIG),
	);
	const env = {
		...process.env,
		HOME: root,
		TMUX: `${socketPath},${pid},0`,
		TMUX_TMPDIR: socketRoot,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_RUNTIME_DIR: join(root, "runtime-a"),
		XDG_STATE_HOME: join(root, "state"),
	};
	cleanups.push(() => {
		Bun.spawnSync(["tmux", "-L", label, "kill-server"], { env: serverEnv });
		for (const daemonPid of daemonPidsFor(socketPath, pid)) {
			try {
				process.kill(daemonPid, "SIGKILL");
			} catch {
				// It already exited.
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	return { env, label, pid, root, socketPath };
}

function tmux(
	label: string,
	env: NodeJS.ProcessEnv,
	args: string[],
): string {
	const result = Bun.spawnSync(["tmux", "-L", label, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
	return new TextDecoder().decode(result.stdout);
}

async function cli(
	server: TestServer,
	command: string,
	envOverrides: NodeJS.ProcessEnv = {},
	commandArgs: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, cliPath, command, ...commandArgs], {
		cwd: projectRoot,
		env: { ...server.env, ...envOverrides },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function daemonPidsFor(socketPath: string, serverPid: number): number[] {
	const matches: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const command = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(
				/\0/g,
				" ",
			);
			if (!command.includes(cliPath) || !command.includes("_daemon")) continue;
			const environment = readFileSync(`/proc/${entry}/environ`, "utf8")
				.split("\0")
				.find((value) =>
					value.startsWith("TMUX_AUTONAME_EXPECTED_SERVER="),
				);
			if (!environment) continue;
			const identity = JSON.parse(environment.slice(environment.indexOf("=") + 1)) as {
				pid?: number;
				socketPath?: string;
			};
			if (identity.pid === serverPid && identity.socketPath === socketPath) {
				matches.push(Number(entry));
			}
		} catch {
			// A process exited while /proc was being read.
		}
	}
	return matches;
}

function processExists(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1 && existsSync(`/proc/${pid}`);
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return predicate();
}

describe("CLI daemon lifecycle", () => {
	test("reset accepts only canonical tmux window ids", async () => {
		const server = createServer();
		const reset = await cli(server, "reset-current", {}, [";"]);
		expect(reset.exitCode).toBe(1);
		expect(reset.stderr).toContain("invalid tmux window id");
	});

	test("concurrent starts share one canonical server lock", async () => {
		const server = createServer();
		const starts = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				cli(server, "start", {
					XDG_RUNTIME_DIR: join(server.root, `runtime-${index % 2}`),
				}),
			),
		);
		expect(starts.every((result) => result.exitCode === 0)).toBe(true);
		expect(await waitFor(() => daemonPidsFor(server.socketPath, server.pid).length === 1)).toBe(
			true,
		);
		expect(daemonPidsFor(server.socketPath, server.pid)).toHaveLength(1);

		const status = await cli(server, "status");
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("running pid=");
		const stopped = await cli(server, "stop");
		expect(stopped.exitCode).toBe(0);
		expect(stopped.stdout).toContain("stopped pid=");
		expect(await waitFor(() => daemonPidsFor(server.socketPath, server.pid).length === 0)).toBe(
			true,
		);
	});

	test("an idempotent start stays quiet", async () => {
		const server = createServer();
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(
			await waitFor(() => daemonPidsFor(server.socketPath, server.pid).length === 1),
		).toBe(true);

		const repeated = await cli(server, "start");
		expect(repeated).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	});

	test("idle daemon exits promptly after its tmux server disappears", async () => {
		const server = createServer();
		expect((await cli(server, "start")).exitCode).toBe(0);
		const [daemonPid] = daemonPidsFor(server.socketPath, server.pid);
		expect(daemonPid).toBeNumber();
		tmux(server.label, server.env, ["kill-server"]);
		expect(
			await waitFor(
				() => daemonPidsFor(server.socketPath, server.pid).length === 0,
				3000,
			),
		).toBe(true);
	});

	test("one-off commands cannot bypass a held lock when the record is missing", async () => {
		const server = createServer();
		expect((await cli(server, "start")).exitCode).toBe(0);
		const windowId = tmux(server.label, server.env, [
			"display-message",
			"-p",
			"#{window_id}",
		]).trim();
		expect(
			await waitFor(() => {
				const result = Bun.spawnSync(
					[
						"tmux",
						"-L",
						server.label,
						"show-options",
						"-wv",
						"-t",
						windowId,
						"@autoname_managed",
					],
					{ env: server.env },
				);
				return result.exitCode === 0;
			}),
		).toBe(true);
		tmux(server.label, server.env, [
			"set-option",
			"-wq",
			"-t",
			windowId,
			"@autoname_manual",
			"1",
		]);
		tmux(server.label, server.env, ["set-option", "-gu", "@autoname_daemon"]);
		tmux(server.label, server.env, ["set-option", "-gu", "@autoname_pid"]);

		const once = await cli(server, "once");
		expect(once.exitCode).toBe(1);
		expect(once.stderr).toContain("daemon or another one-off scan is active");

		const reset = await cli(server, "reset-current");
		expect(reset.exitCode).toBe(1);
		expect(reset.stderr).toContain("no healthy daemon is recorded");
		expect(
			tmux(server.label, server.env, [
				"show-options",
				"-wv",
				"-t",
				windowId,
				"@autoname_manual",
			]).trim(),
		).toBe("1");
		expect(daemonPidsFor(server.socketPath, server.pid)).toHaveLength(1);
	});

	test("reset replaces an outdated daemon before queueing the request", async () => {
		const server = createServer();
		const windowId = tmux(server.label, server.env, [
			"new-window",
			"-dP",
			"-F",
			"#{window_id}",
			"-n",
			"pi:old-name",
			"bash -c 'exec -a pi sleep 10'",
		]).trim();
		expect((await cli(server, "start")).exitCode).toBe(0);
		const encoded = tmux(server.label, server.env, [
			"show-options",
			"-gv",
			"@autoname_daemon",
		]).trim();
		const record = JSON.parse(encoded) as { codeVersion: string; pid: number };
		const oldPid = record.pid;
		record.codeVersion = "0".repeat(64);
		tmux(server.label, server.env, [
			"set-option",
			"-gq",
			"@autoname_daemon",
			JSON.stringify(record),
		]);

		const reset = await cli(server, "reset-current", {}, [windowId]);
		expect(reset.exitCode).toBe(0);
		expect(
			await waitFor(() => {
				const pids = daemonPidsFor(server.socketPath, server.pid);
				return pids.length === 1 && pids[0] !== oldPid;
			}),
		).toBe(true);
		expect(
			await waitFor(
				() =>
					tmux(server.label, server.env, [
						"display-message",
						"-p",
						"-t",
						windowId,
						"#{window_name}",
					]).trim() === "tmux",
			),
		).toBe(true);
		expect((await cli(server, "status")).stdout).toContain("running pid=");
		expect((await cli(server, "stop")).exitCode).toBe(0);
	});

	test("reset without a daemon clears an old AI name without making it manual", async () => {
		const server = createServer();
		const windowId = tmux(server.label, server.env, [
			"new-window",
			"-dP",
			"-F",
			"#{window_id}",
			"-n",
			"pi:old-name",
			"bash -c 'exec -a pi sleep 10'",
		]).trim();
		tmux(server.label, server.env, [
			"set-option",
			"-wq",
			"-t",
			windowId,
			"@autoname_manual",
			"1",
		]);

		const reset = await cli(server, "reset-current", {}, [windowId]);
		expect(reset.exitCode).toBe(0);
		expect(
			tmux(server.label, server.env, [
				"display-message",
				"-p",
				"-t",
				windowId,
				"#{window_name}",
			]).trim(),
		).toBe("tmux");
		expect((await cli(server, "once")).exitCode).toBe(0);
		const manual = Bun.spawnSync(
			[
				"tmux",
				"-L",
				server.label,
				"show-options",
				"-wv",
				"-t",
				windowId,
				"@autoname_manual",
			],
			{ env: server.env },
		);
		expect(manual.exitCode).not.toBe(0);
	});

	test("manual rename wins during a reset without a daemon", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin-reset-barrier");
		const marker = join(server.root, "reset-scan-blocked");
		const release = join(server.root, "reset-scan-release");
		mkdirSync(fakeBin);
		const realTmux = Bun.which("tmux");
		if (!realTmux) throw new Error("tmux is required for lifecycle tests");
		const fakeTmux = join(fakeBin, "tmux");
		writeFileSync(
			fakeTmux,
			`#!/bin/sh
if [ -n "\${TMUX_AUTONAME_EXPECTED_SERVER:-}" ] && [ "$1" = "list-panes" ]; then
  : > "$TMUX_AUTONAME_BARRIER_MARKER"
  while [ ! -e "$TMUX_AUTONAME_BARRIER_RELEASE" ]; do
    sleep 0.02
  done
fi
exec "$TMUX_AUTONAME_REAL_TMUX" "$@"
`,
		);
		chmodSync(fakeTmux, 0o755);
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.TMUX_AUTONAME_REAL_TMUX = realTmux;
		server.env.TMUX_AUTONAME_BARRIER_MARKER = marker;
		server.env.TMUX_AUTONAME_BARRIER_RELEASE = release;

		const windowId = tmux(server.label, server.env, [
			"new-window",
			"-dP",
			"-F",
			"#{window_id}",
			"-n",
			"pi:old-name",
			"bash -c 'exec sleep 10'",
		]).trim();
		tmux(server.label, server.env, [
			"set-option",
			"-wq",
			"-t",
			windowId,
			"@autoname_managed",
			"1",
		]);
		tmux(server.label, server.env, [
			"set-option",
			"-wq",
			"-t",
			windowId,
			"@autoname_last_name",
			"pi:old-name",
		]);

		const reset = cli(server, "reset-current", {}, [windowId]);
		expect(await waitFor(() => existsSync(marker), 3000)).toBe(true);
		tmux(server.label, server.env, [
			"rename-window",
			"-t",
			windowId,
			"manual-during-reset",
		]);
		writeFileSync(release, "");
		expect((await reset).exitCode).toBe(0);
		expect(
			tmux(server.label, server.env, [
				"display-message",
				"-p",
				"-t",
				windowId,
				"#{window_name}",
			]).trim(),
		).toBe("manual-during-reset");
		expect(
			tmux(server.label, server.env, [
				"show-options",
				"-wqv",
				"-t",
				windowId,
				"@autoname_manual",
			]).trim(),
		).toBe("1");
	});

	test("manual rename after reset wins even when it matches the old managed name", async () => {
		const server = createServer();
		writeFileSync(
			join(server.root, "config", "tmux-autoname", "config.toml"),
			defaultConfigToml({
				...DEFAULT_CONFIG,
				naming: { ...DEFAULT_CONFIG.naming, pollSeconds: 1 },
			}),
		);
		const windowId = tmux(server.label, server.env, [
			"display-message",
			"-p",
			"#{window_id}",
		]).trim();
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(
			await waitFor(() => {
				const managed = Bun.spawnSync(
					[
						"tmux",
						"-L",
						server.label,
						"show-options",
						"-wv",
						"-t",
						windowId,
						"@autoname_managed",
					],
					{ env: server.env },
				);
				return managed.exitCode === 0;
			}),
		).toBe(true);
		const oldManagedName = tmux(server.label, server.env, [
			"display-message",
			"-p",
			"-t",
			windowId,
			"#{window_name}",
		]).trim();

		expect((await cli(server, "reset-current", {}, [windowId])).exitCode).toBe(0);
		tmux(server.label, server.env, [
			"rename-window",
			"-t",
			windowId,
			oldManagedName,
		]);
		expect(
			await waitFor(() => {
				const manual = Bun.spawnSync(
					[
						"tmux",
						"-L",
						server.label,
						"show-options",
						"-wv",
						"-t",
						windowId,
						"@autoname_manual",
					],
					{ env: server.env },
				);
				return manual.exitCode === 0;
			}, 3000),
		).toBe(true);
		expect(
			tmux(server.label, server.env, [
				"display-message",
				"-p",
				"-t",
				windowId,
				"#{window_name}",
			]).trim(),
		).toBe(oldManagedName);
		expect((await cli(server, "stop")).exitCode).toBe(0);
	});

	test("concurrent starts wait for a slow winner to publish its record", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin-record-delay");
		mkdirSync(fakeBin);
		const fakeTmux = join(fakeBin, "tmux");
		writeFileSync(
			fakeTmux,
			`#!/bin/sh
if [ -n "\${TMUX_AUTONAME_EXPECTED_SERVER:-}" ] && [ "$1" = "set-option" ] && [ "$3" = "@autoname_daemon" ]; then
  sleep 0.25
fi
exec "$TMUX_AUTONAME_REAL_TMUX" "$@"
`,
		);
		chmodSync(fakeTmux, 0o755);
		const realTmux = Bun.which("tmux");
		if (!realTmux) throw new Error("tmux is required for lifecycle tests");
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.TMUX_AUTONAME_REAL_TMUX = realTmux;

		const starts = await Promise.all([cli(server, "start"), cli(server, "start")]);
		expect(starts.every((result) => result.exitCode === 0)).toBe(true);
		expect(await waitFor(() => daemonPidsFor(server.socketPath, server.pid).length === 1)).toBe(
			true,
		);
		expect((await cli(server, "stop")).exitCode).toBe(0);
	});

	test("stop cancels an in-flight provider request", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin");
		const marker = join(server.root, "pi-started");
		mkdirSync(fakeBin);
		const fakePi = join(fakeBin, "pi");
		writeFileSync(
			fakePi,
			`#!/bin/sh\ntouch "$FAKE_PI_STARTED"\nexec sleep 10\n`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(server.root, "config", "tmux-autoname", "config.toml"),
			defaultConfigToml({
				...DEFAULT_CONFIG,
				llm: { ...DEFAULT_CONFIG.llm, enabled: true },
				naming: {
					...DEFAULT_CONFIG.naming,
					minNonEmptyLines: 0,
					pollSeconds: 1,
				},
			}),
		);
		tmux(server.label, server.env, [
			"new-window",
			"-d",
			"bash -c 'exec -a pi sleep 10'",
		]);
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.FAKE_PI_STARTED = marker;
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(await waitFor(() => existsSync(marker), 3000)).toBe(true);

		const startedAt = performance.now();
		const stopped = await cli(server, "stop");
		expect(stopped.exitCode).toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(2000);
		expect(await waitFor(() => daemonPidsFor(server.socketPath, server.pid).length === 0)).toBe(
			true,
		);
	});

	test("reset invalidates a provider result that is already in flight", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin-reset-race");
		const marker = join(server.root, "pi-reset-race-pid");
		const release = join(server.root, "pi-reset-race-release");
		mkdirSync(fakeBin);
		const fakePi = join(fakeBin, "pi");
		writeFileSync(
			fakePi,
			`#!/bin/sh
echo "$$" > "$FAKE_PI_PID"
while [ ! -e "$FAKE_PI_RELEASE" ]; do
  sleep 0.02
done
printf '%s\n' stale-name
`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(server.root, "config", "tmux-autoname", "config.toml"),
			defaultConfigToml({
				...DEFAULT_CONFIG,
				llm: { ...DEFAULT_CONFIG.llm, enabled: true },
				naming: {
					...DEFAULT_CONFIG.naming,
					minNonEmptyLines: 0,
					pollSeconds: 1,
				},
			}),
		);
		const windowId = tmux(server.label, server.env, [
			"new-window",
			"-dP",
			"-F",
			"#{window_id}",
			"-n",
			"tmux",
			"bash -c 'exec -a pi sleep 10'",
		]).trim();
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.FAKE_PI_PID = marker;
		server.env.FAKE_PI_RELEASE = release;
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(await waitFor(() => existsSync(marker), 3000)).toBe(true);
		const providerPid = Number(readFileSync(marker, "utf8").trim());
		cleanups.push(() => {
			if (!processExists(providerPid)) return;
			try {
				process.kill(providerPid, "SIGKILL");
			} catch {
				// It already exited.
			}
		});

		const reset = await cli(server, "reset-current", {}, [windowId]);
		expect(reset.exitCode).toBe(0);
		writeFileSync(release, "");
		expect(await waitFor(() => !processExists(providerPid), 2000)).toBe(true);
		expect(
			tmux(server.label, server.env, [
				"display-message",
				"-p",
				"-t",
				windowId,
				"#{window_name}",
			]).trim(),
		).toBe("tmux");
		const locked = Bun.spawnSync(
			[
				"tmux",
				"-L",
				server.label,
				"show-options",
				"-wv",
				"-t",
				windowId,
				"@autoname_locked",
			],
			{ env: server.env },
		);
		expect(locked.exitCode).not.toBe(0);
		expect((await cli(server, "stop")).exitCode).toBe(0);
	});

	test("manual rename wins over a provider result already in flight", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin-manual-race");
		const marker = join(server.root, "pi-manual-race-pid");
		const release = join(server.root, "pi-manual-race-release");
		mkdirSync(fakeBin);
		const fakePi = join(fakeBin, "pi");
		writeFileSync(
			fakePi,
			`#!/bin/sh
echo "$$" > "$FAKE_PI_PID"
while [ ! -e "$FAKE_PI_RELEASE" ]; do
  sleep 0.02
done
printf '%s\n' stale-name
`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(server.root, "config", "tmux-autoname", "config.toml"),
			defaultConfigToml({
				...DEFAULT_CONFIG,
				llm: { ...DEFAULT_CONFIG.llm, enabled: true },
				naming: {
					...DEFAULT_CONFIG.naming,
					minNonEmptyLines: 0,
					pollSeconds: 1,
				},
			}),
		);
		const windowId = tmux(server.label, server.env, [
			"new-window",
			"-dP",
			"-F",
			"#{window_id}",
			"-n",
			"tmux",
			"bash -c 'exec -a pi sleep 10'",
		]).trim();
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.FAKE_PI_PID = marker;
		server.env.FAKE_PI_RELEASE = release;
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(await waitFor(() => existsSync(marker), 3000)).toBe(true);
		const providerPid = Number(readFileSync(marker, "utf8").trim());
		cleanups.push(() => {
			if (!processExists(providerPid)) return;
			try {
				process.kill(providerPid, "SIGKILL");
			} catch {
				// It already exited.
			}
		});

		tmux(server.label, server.env, [
			"rename-window",
			"-t",
			windowId,
			"my-manual-name",
		]);
		writeFileSync(release, "");
		expect(await waitFor(() => !processExists(providerPid), 2000)).toBe(true);
		await Bun.sleep(100);
		expect(
			tmux(server.label, server.env, [
				"display-message",
				"-p",
				"-t",
				windowId,
				"#{window_name}",
			]).trim(),
		).toBe("my-manual-name");
		expect(
			await waitFor(
				() =>
					tmux(server.label, server.env, [
						"show-options",
						"-wqv",
						"-t",
						windowId,
						"@autoname_manual",
					]).trim() === "1",
				3000,
			),
		).toBe(true);
		expect((await cli(server, "stop")).exitCode).toBe(0);
	});

	test("server loss cancels an in-flight provider request", async () => {
		const server = createServer();
		const fakeBin = join(server.root, "bin-server-loss");
		const marker = join(server.root, "pi-server-loss-pid");
		mkdirSync(fakeBin);
		const fakePi = join(fakeBin, "pi");
		writeFileSync(
			fakePi,
			`#!/bin/sh\necho "$$" > "$FAKE_PI_PID"\nexec sleep 10\n`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(server.root, "config", "tmux-autoname", "config.toml"),
			defaultConfigToml({
				...DEFAULT_CONFIG,
				llm: { ...DEFAULT_CONFIG.llm, enabled: true },
				naming: {
					...DEFAULT_CONFIG.naming,
					minNonEmptyLines: 0,
					pollSeconds: 1,
				},
			}),
		);
		tmux(server.label, server.env, [
			"new-window",
			"-d",
			"bash -c 'exec -a pi sleep 10'",
		]);
		server.env.PATH = `${fakeBin}:${server.env.PATH ?? ""}`;
		server.env.FAKE_PI_PID = marker;
		expect((await cli(server, "start")).exitCode).toBe(0);
		expect(await waitFor(() => existsSync(marker), 3000)).toBe(true);
		const providerPid = Number(readFileSync(marker, "utf8").trim());
		expect(processExists(providerPid)).toBe(true);
		cleanups.push(() => {
			if (!processExists(providerPid)) return;
			try {
				process.kill(providerPid, "SIGKILL");
			} catch {
				// It already exited.
			}
		});

		tmux(server.label, server.env, ["kill-server"]);
		expect(
			await waitFor(
				() => daemonPidsFor(server.socketPath, server.pid).length === 0,
				2000,
			),
		).toBe(true);
		expect(await waitFor(() => !processExists(providerPid), 2000)).toBe(true);
	});
});
