#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { PiCliLlmAdapter } from "../src/ai-namer.ts";
import { codeVersion } from "../src/code-version.ts";
import {
	processIdentity,
	processMatches,
	run,
	runAsync,
} from "../src/command.ts";
import { configPaths, ensureConfig, readConfig } from "../src/config-codec.ts";
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
import {
	createRuntimeLogger,
	pruneDaemonLogs,
} from "../src/runtime-logger.ts";
import { runtimePaths } from "../src/runtime-paths.ts";
import { WindowScanner } from "../src/scanner.ts";
import { TmuxCliAdapter } from "../src/tmux-adapter.ts";
import type { Config, TmuxServerIdentity } from "../src/types.ts";

const CONFIG_PATHS = configPaths();
const BASE_RUNTIME_PATHS = runtimePaths();
const STARTUP_SERVER = expectedServer();
const RUNTIME_PATHS = STARTUP_SERVER
	? {
			...BASE_RUNTIME_PATHS,
			logPath: daemonLogPath(BASE_RUNTIME_PATHS.stateDir, STARTUP_SERVER),
		}
	: BASE_RUNTIME_PATHS;
const SCRIPT_PATH = import.meta.path;
const BUILD = {
	codeVersion: codeVersion(join(import.meta.dir, "..")),
	scriptPath: realpathSync(SCRIPT_PATH),
};
const FOREGROUND_ENV = "TMUX_AUTONAME_FOREGROUND";
const SERVER_HEALTH_INTERVAL_MS = 250;
const log = createRuntimeLogger(RUNTIME_PATHS, {
	echo: process.env[FOREGROUND_ENV] === "1",
});

const tmux = new TmuxCliAdapter(run);
const llm = new PiCliLlmAdapter(runAsync, log);
const scanner = new WindowScanner({ tmux, llm, run, log });

function loadConfig() {
	const result = readConfig(CONFIG_PATHS, log);
	for (const warning of result.warnings) log(`config warning: ${warning}`);
	return result.config;
}

async function scanOnceFromCli(): Promise<void> {
	const identity = requireServer();
	const exitCode = await runLockedSubcommand(identity, "_once");
	if (exitCode === 75) {
		throw new Error("daemon or another one-off scan is active for this tmux server");
	}
	if (exitCode !== 0) throw new Error(`one-off scan failed (exit ${exitCode})`);
}

function requireServer(): TmuxServerIdentity {
	const identity = tmux.serverIdentity();
	if (!identity) throw new Error("no reachable tmux server in this environment");
	return identity;
}

function requireExpectedServer(): TmuxServerIdentity {
	const expected = STARTUP_SERVER;
	if (!expected) throw new Error("missing internal tmux server identity");
	if (!sameServer(tmux.serverIdentity(), expected)) {
		throw new Error("tmux server changed before locked command startup");
	}
	return expected;
}

async function runLockedSubcommand(
	identity: TmuxServerIdentity,
	command: string,
	args: string[] = [],
): Promise<number> {
	const lockPath = prepareLockFile(serverRuntimeDir(identity), identity);
	const proc = Bun.spawn(
		flockCommand(
			lockPath,
			process.execPath,
			SCRIPT_PATH,
			command,
			args,
		),
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: daemonEnvironment(identity),
		},
	);
	return await proc.exited;
}

async function scanWhileServerCurrent(
	identity: TmuxServerIdentity,
	config: Config,
	onlyWindowId?: string,
	force = false,
	stopSignal?: AbortSignal,
): Promise<void> {
	const serverAbortController = new AbortController();
	const isServerCurrent = (): boolean =>
		sameServer(tmux.serverIdentity(), identity);
	const monitor = setInterval(() => {
		if (!isServerCurrent()) serverAbortController.abort();
	}, SERVER_HEALTH_INTERVAL_MS);
	const signal = stopSignal
		? AbortSignal.any([stopSignal, serverAbortController.signal])
		: serverAbortController.signal;
	try {
		if (!isServerCurrent()) throw new Error("tmux server changed before scan");
		await scanner.scanOnce(
			config,
			onlyWindowId,
			force,
			signal,
			isServerCurrent,
		);
		if (!isServerCurrent()) throw new Error("tmux server changed during scan");
	} finally {
		clearInterval(monitor);
	}
}

async function lockedScanOnce(): Promise<void> {
	const identity = requireExpectedServer();
	ensureConfig(CONFIG_PATHS, log);
	await scanWhileServerCurrent(identity, loadConfig());
}

async function startDaemon(): Promise<void> {
	ensureConfig(CONFIG_PATHS, log);
	const identity = requireServer();
	const initial = readDaemonStatus(tmux, identity, BUILD);
	if (initial.state === "running") {
		return;
	}
	if (initial.state === "outdated") {
		console.log(`tmux-autoname replacing outdated pid=${initial.record.pid}`);
		if (!(await stopRecord(initial.record))) {
			throw new Error(`outdated daemon did not stop pid=${initial.record.pid}`);
		}
	}

	const lockPath = prepareLockFile(serverRuntimeDir(identity), identity);
	let childResult: {
		exitCode: number | null;
		signalCode: number | null;
	} | null = null;
	const observedChildResult = () => childResult;
	const proc = Bun.spawn(
		flockCommand(lockPath, process.execPath, SCRIPT_PATH),
		{
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
			env: daemonEnvironment(identity),
			onExit(_subprocess, exitCode, signalCode) {
				childResult = { exitCode, signalCode };
			},
		},
	);
	proc.unref();

	for (let attempt = 0; attempt < 20; attempt += 1) {
		await Bun.sleep(50);
		const status = readDaemonStatus(tmux, identity, BUILD);
		if (status.state === "running") {
			console.log(`tmux-autoname running pid=${status.record.pid}`);
			return;
		}
		const observed = observedChildResult();
		if (observed !== null && observed.exitCode !== 75) break;
	}

	const finalChildResult = observedChildResult();
	if (finalChildResult === null) {
		console.log(`tmux-autoname starting pid=${proc.pid}`);
		return;
	}
	const { exitCode, signalCode } = finalChildResult;
	throw new Error(
		exitCode === 75
			? "tmux-autoname lock is held but no healthy daemon is recorded"
			: `tmux-autoname failed to start (${exitCode === null ? `signal ${signalCode ?? "unknown"}` : `exit ${exitCode}`})`,
	);
}

async function runForegroundDaemon(): Promise<void> {
	ensureConfig(CONFIG_PATHS, log);
	const identity = requireServer();
	const status = readDaemonStatus(tmux, identity, BUILD);
	if (status.state === "running") {
		console.log(`tmux-autoname already running pid=${status.record.pid}`);
		return;
	}
	if (status.state === "outdated") {
		if (!(await stopRecord(status.record))) {
			throw new Error(`outdated daemon did not stop pid=${status.record.pid}`);
		}
	}

	const lockPath = prepareLockFile(serverRuntimeDir(identity), identity);
	const proc = Bun.spawn(
		flockCommand(lockPath, process.execPath, SCRIPT_PATH),
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: {
				...daemonEnvironment(identity),
				[FOREGROUND_ENV]: "1",
			},
		},
	);
	const forwardSignal = (signal: NodeJS.Signals): void => {
		try {
			proc.kill(signal);
		} catch {
			// The child already exited.
		}
	};
	const forwardTerm = (): void => forwardSignal("SIGTERM");
	const forwardInterrupt = (): void => forwardSignal("SIGINT");
	process.on("SIGTERM", forwardTerm);
	process.on("SIGINT", forwardInterrupt);
	try {
		const exitCode = await proc.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
	} finally {
		process.off("SIGTERM", forwardTerm);
		process.off("SIGINT", forwardInterrupt);
	}
}

async function daemon(): Promise<void> {
	const expected = requireExpectedServer();
	const self = processIdentity(process.pid);
	if (!self) throw new Error("cannot read daemon process identity");

	ensureConfig(CONFIG_PATHS, log);
	const record = writeDaemonRecord(tmux, expected, self, BUILD);

	let stopping = false;
	const abortController = new AbortController();
	const handleSignal = (): void => {
		stopping = true;
		abortController.abort();
	};
	const handleServerChange = (): void => {
		stopping = true;
		abortController.abort();
	};
	process.on("SIGTERM", handleSignal);
	process.on("SIGINT", handleSignal);

	try {
		log(`daemon started pid=${process.pid} tmux_pid=${expected.pid}`);
		try {
			pruneDaemonLogs(RUNTIME_PATHS.stateDir, RUNTIME_PATHS.logPath);
		} catch {
			log("daemon log retention failed");
		}
		while (!stopping) {
			if (!sameServer(tmux.serverIdentity(), expected)) {
				handleServerChange();
				break;
			}

			let pollSeconds = 30;
			try {
				const config = loadConfig();
				pollSeconds = Math.max(1, config.naming.pollSeconds);
				await scanWhileServerCurrent(
					expected,
					config,
					undefined,
					false,
					abortController.signal,
				);
			} catch (error) {
				if (sameServer(tmux.serverIdentity(), expected)) {
					const message = error instanceof Error ? error.message : String(error);
					log(`scan failed: ${message}`);
				}
			}
			if (!sameServer(tmux.serverIdentity(), expected)) {
				handleServerChange();
				break;
			}
			await sleepUntilNextScan(
				pollSeconds * 1000,
				() => stopping || !processMatches(expected),
			);
		}
	} finally {
		if (!sameServer(tmux.serverIdentity(), expected)) {
			log("tmux server changed or stopped; daemon exiting");
		}
		clearDaemonRecord(tmux, record);
		process.off("SIGTERM", handleSignal);
		process.off("SIGINT", handleSignal);
		log(`daemon stopped pid=${process.pid}`);
	}
}

async function sleepUntilNextScan(
	durationMs: number,
	shouldStop: () => boolean,
): Promise<void> {
	const deadline = Date.now() + durationMs;
	while (!shouldStop() && Date.now() < deadline) {
		await Bun.sleep(Math.min(250, deadline - Date.now()));
	}
}

async function stopDaemon(): Promise<void> {
	const identity = requireServer();
	const status = readDaemonStatus(tmux, identity, BUILD);
	if (status.state !== "running" && status.state !== "outdated") {
		console.log("tmux-autoname is not running for this tmux server");
		return;
	}

	if (!(await stopRecord(status.record))) {
		throw new Error(`tmux-autoname did not stop pid=${status.record.pid}`);
	}
	console.log(`tmux-autoname stopped pid=${status.record.pid}`);
}

async function stopRecord(record: { pid: number; startTicks: string }): Promise<boolean> {
	if (!processMatches(record)) return true;
	try {
		process.kill(record.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		throw error;
	}
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (!processMatches(record)) return true;
		await Bun.sleep(50);
	}
	return false;
}

function showStatus(): void {
	const identity = requireServer();
	const status = readDaemonStatus(tmux, identity, BUILD);
	if (status.state === "running") {
		console.log(`tmux-autoname running pid=${status.record.pid}`);
		return;
	}
	if (status.state === "outdated") {
		console.log(`tmux-autoname outdated pid=${status.record.pid}`);
		return;
	}
	console.log("tmux-autoname stopped");
}

async function resetCurrent(windowId?: string): Promise<void> {
	const target =
		windowId && windowId.length > 0 ? windowId : tmux.currentWindowId();
	if (!target) throw new Error("missing tmux window id");
	if (!/^@\d+$/.test(target)) throw new Error(`invalid tmux window id: ${target}`);
	const identity = requireServer();
	const exitCode = await runLockedSubcommand(identity, "_reset-current", [target]);
	if (exitCode === 0) return;
	if (exitCode !== 75) {
		throw new Error(`reset scan failed (exit ${exitCode})`);
	}

	const status = readDaemonStatus(tmux, identity, BUILD);
	if (status.state !== "running" && status.state !== "outdated") {
		throw new Error("server lock is held but no healthy daemon is recorded; retry");
	}
	if (status.state === "outdated") {
		if (!(await stopRecord(status.record))) {
			throw new Error(`outdated daemon did not stop pid=${status.record.pid}`);
		}
		queueReset(target);
		await startDaemon();
		return;
	}
	queueReset(target);
}

function queueReset(target: string): void {
	tmux.requestWindowReset(target);
	log(`reset ${target}`);
	tmux.displayMessage(`tmux-autoname reset ${target}; rescan on next poll`);
}

async function lockedResetCurrent(windowId?: string): Promise<void> {
	const identity = requireExpectedServer();
	if (!windowId) throw new Error("missing tmux window id");
	if (!/^@\d+$/.test(windowId)) throw new Error(`invalid tmux window id: ${windowId}`);
	ensureConfig(CONFIG_PATHS, log);
	tmux.requestWindowReset(windowId);
	log(`reset ${windowId}`);
	await scanWhileServerCurrent(identity, loadConfig(), windowId, true);
	tmux.displayMessage(`tmux-autoname reset ${windowId}`);
}

function usage(): void {
	console.log(`tmux-autoname commands:
  start                 start one daemon for the current tmux server
  stop                  stop the current tmux server daemon
  status                show daemon status for the current tmux server
  daemon                run a foreground daemon
  once                  scan once
  reset-current [@id]   clear current window lock/manual state and rescan
  config                print config path
`);
}

const command = process.argv[2] ?? "help";
try {
	if (command === "start") await startDaemon();
	else if (command === "stop") await stopDaemon();
	else if (command === "status") showStatus();
	else if (command === "daemon") await runForegroundDaemon();
	else if (command === "_daemon") await daemon();
	else if (command === "_once") await lockedScanOnce();
	else if (command === "_reset-current")
		await lockedResetCurrent(process.argv[3]);
	else if (command === "once") await scanOnceFromCli();
	else if (command === "reset-current") await resetCurrent(process.argv[3]);
	else if (command === "config") console.log(CONFIG_PATHS.configPath);
	else usage();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	log(`fatal: ${message}`);
	console.error(message);
	process.exit(1);
}
