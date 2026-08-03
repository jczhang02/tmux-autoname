import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	openSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { processMatches } from "./command.ts";
import type { TmuxAdapter } from "./tmux-adapter.ts";
import type { ProcessIdentity, TmuxServerIdentity } from "./types.ts";
import {
	currentUid,
	ensurePrivateRuntimeDirectory,
} from "./runtime-paths.ts";

const EXPECTED_SERVER_ENV = "TMUX_AUTONAME_EXPECTED_SERVER";
const PID_OPTION = "@autoname_pid";
const RECORD_OPTION = "@autoname_daemon";

export interface DaemonRecord extends ProcessIdentity {
	codeVersion: string;
	scriptPath: string;
	serverKey: string;
}

export interface RuntimeBuild {
	codeVersion: string;
	scriptPath: string;
}

export type DaemonStatus =
	| { state: "running"; record: DaemonRecord }
	| { state: "outdated"; record: DaemonRecord }
	| { state: "stale"; record: DaemonRecord | null }
	| { state: "stopped"; record: null };

export function sameServer(
	left: TmuxServerIdentity | null,
	right: TmuxServerIdentity,
): boolean {
	return (
		left !== null &&
		left.socketPath === right.socketPath &&
		left.pid === right.pid &&
		left.startTicks === right.startTicks
	);
}

export function serverKey(identity: TmuxServerIdentity): string {
	return createHash("sha256")
		.update(
			`${identity.socketPath}\0${identity.pid}\0${identity.startTicks}`,
			"utf8",
		)
		.digest("hex");
}

export function daemonLogPath(
	stateDir: string,
	identity: TmuxServerIdentity,
): string {
	return join(stateDir, `daemon-${serverKey(identity)}.log`);
}

export function prepareLockFile(
	runtimeDir: string,
	identity: TmuxServerIdentity,
): string {
	ensurePrivateRuntimeDirectory(runtimeDir);
	const path = join(runtimeDir, `${serverKey(identity)}.lock`);
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
		throw new Error(`refusing symlink lock path: ${path}`);
	}
	const descriptor = openSync(path, "a", 0o600);
	closeSync(descriptor);
	chmodSync(path, 0o600);
	return path;
}

export function serverRuntimeDir(identity: TmuxServerIdentity): string {
	return join(
		dirname(identity.socketPath),
		`.tmux-autoname-${currentUid()}`,
	);
}

export function flockCommand(
	lockPath: string,
	executable: string,
	scriptPath: string,
	command = "_daemon",
	commandArgs: string[] = [],
): string[] {
	return [
		"flock",
		"--exclusive",
		"--nonblock",
		"--conflict-exit-code",
		"75",
		"--no-fork",
		lockPath,
		executable,
		scriptPath,
		command,
		...commandArgs,
	];
}

export function daemonEnvironment(
	identity: TmuxServerIdentity,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...env,
		[EXPECTED_SERVER_ENV]: JSON.stringify(identity),
	};
}

export function expectedServer(
	env: NodeJS.ProcessEnv = process.env,
): TmuxServerIdentity | null {
	const encoded = env[EXPECTED_SERVER_ENV];
	if (!encoded) return null;
	try {
		const parsed = JSON.parse(encoded) as Partial<TmuxServerIdentity>;
		const pid = parsed.pid;
		if (
			typeof parsed.socketPath !== "string" ||
			parsed.socketPath.length === 0 ||
			typeof pid !== "number" ||
			!Number.isInteger(pid) ||
			pid <= 1 ||
			typeof parsed.startTicks !== "string" ||
			!/^\d+$/.test(parsed.startTicks)
		) {
			return null;
		}
		return {
			socketPath: parsed.socketPath,
			pid,
			startTicks: parsed.startTicks,
		};
	} catch {
		return null;
	}
}

export function readDaemonStatus(
	tmux: TmuxAdapter,
	identity: TmuxServerIdentity,
	build: RuntimeBuild,
): DaemonStatus {
	const encoded = tmux.readGlobalOption(RECORD_OPTION);
	if (!encoded) {
		return tmux.readGlobalOption(PID_OPTION)
			? { state: "stale", record: null }
			: { state: "stopped", record: null };
	}
	const record = decodeDaemonRecord(encoded);
	if (!record) return { state: "stale", record: null };
	if (record.serverKey !== serverKey(identity) || !processMatches(record)) {
		return { state: "stale", record };
	}
	if (
		record.codeVersion !== build.codeVersion ||
		record.scriptPath !== build.scriptPath
	) {
		return { state: "outdated", record };
	}
	return { state: "running", record };
}

export function writeDaemonRecord(
	tmux: TmuxAdapter,
	identity: TmuxServerIdentity,
	processIdentity: ProcessIdentity,
	build: RuntimeBuild,
): DaemonRecord {
	const record = { ...processIdentity, ...build, serverKey: serverKey(identity) };
	tmux.setGlobalOption(RECORD_OPTION, encodeDaemonRecord(record));
	tmux.setGlobalOption(PID_OPTION, String(processIdentity.pid));
	return record;
}

export function clearDaemonRecord(
	tmux: TmuxAdapter,
	expected: DaemonRecord,
): void {
	if (tmux.readGlobalOption(RECORD_OPTION) !== encodeDaemonRecord(expected)) return;
	tmux.unsetGlobalOption(RECORD_OPTION);
	if (tmux.readGlobalOption(PID_OPTION) === String(expected.pid)) {
		tmux.unsetGlobalOption(PID_OPTION);
	}
}

function encodeDaemonRecord(record: DaemonRecord): string {
	return JSON.stringify({
		pid: record.pid,
		startTicks: record.startTicks,
		serverKey: record.serverKey,
		codeVersion: record.codeVersion,
		scriptPath: record.scriptPath,
	});
}

function decodeDaemonRecord(encoded: string): DaemonRecord | null {
	try {
		const parsed = JSON.parse(encoded) as Partial<DaemonRecord>;
		if (
			typeof parsed.pid !== "number" ||
			!Number.isInteger(parsed.pid) ||
			parsed.pid <= 1 ||
			typeof parsed.startTicks !== "string" ||
			!/^\d+$/.test(parsed.startTicks) ||
			typeof parsed.serverKey !== "string" ||
			!/^[a-f0-9]{64}$/.test(parsed.serverKey) ||
			typeof parsed.codeVersion !== "string" ||
			!/^[a-f0-9]{64}$/.test(parsed.codeVersion) ||
			typeof parsed.scriptPath !== "string" ||
			!parsed.scriptPath.startsWith("/")
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			startTicks: parsed.startTicks,
			serverKey: parsed.serverKey,
			codeVersion: parsed.codeVersion,
			scriptPath: parsed.scriptPath,
		};
	} catch {
		return null;
	}
}
