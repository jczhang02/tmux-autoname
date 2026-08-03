import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Logger } from "./types.ts";
import {
	ensurePrivateDirectory,
	hardenRegularFile,
	type RuntimePaths,
} from "./runtime-paths.ts";

export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_DAEMON_LOG_FAMILIES = 8;
const MAX_LOG_MESSAGE_BYTES = 8 * 1024;

export interface LoggerOptions {
	echo?: boolean;
	maxBytes?: number;
}

export function createRuntimeLogger(
	paths: RuntimePaths,
	options: LoggerOptions = {},
): Logger {
	const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
	return (message: string): void => {
		const safeMessage = truncateUtf8(
			message.replace(/[\u0000-\u001f\u007f]/g, " "),
			MAX_LOG_MESSAGE_BYTES,
		);
		const line = `[${new Date().toISOString()}] ${safeMessage}\n`;
		try {
			ensurePrivateDirectory(paths.stateDir);
			rotateIfNeeded(paths.logPath, Buffer.byteLength(line, "utf8"), maxBytes);
			appendFileSync(paths.logPath, line, { encoding: "utf8", mode: 0o600 });
			chmodSync(paths.logPath, 0o600);
		} catch {
			console.error("tmux-autoname: unable to write private log");
		}
		if (options.echo) console.log(line.trimEnd());
	};
}

export function pruneDaemonLogs(
	stateDir: string,
	activeLogPath: string,
	maxFamilies = MAX_DAEMON_LOG_FAMILIES,
): void {
	ensurePrivateDirectory(stateDir);
	const activeFamily = basename(activeLogPath).replace(/\.log$/, "");
	const families = new Map<
		string,
		{ modifiedAt: number; paths: string[] }
	>();
	for (const entry of readdirSync(stateDir)) {
		const match = entry.match(/^(daemon-[a-f0-9]{64})\.log(?:\.1)?$/);
		const family = match?.[1];
		if (!family) continue;
		const path = join(stateDir, entry);
		let metadata;
		try {
			metadata = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
		const existing = families.get(family) ?? { modifiedAt: 0, paths: [] };
		existing.modifiedAt = Math.max(existing.modifiedAt, metadata.mtimeMs);
		existing.paths.push(path);
		families.set(family, existing);
	}

	const keep = new Set<string>([activeFamily]);
	for (const [family] of [...families.entries()]
		.filter(([family]) => family !== activeFamily)
		.sort((left, right) => right[1].modifiedAt - left[1].modifiedAt)
		.slice(0, Math.max(0, maxFamilies - 1))) {
		keep.add(family);
	}
	for (const [family, metadata] of families) {
		if (keep.has(family)) continue;
		for (const path of metadata.paths) {
			try {
				unlinkSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	return bytes.byteLength > maxBytes
		? bytes.subarray(0, maxBytes).toString("utf8")
		: value;
}

function rotateIfNeeded(
	logPath: string,
	incomingBytes: number,
	maxBytes: number,
): void {
	if (!existsSync(logPath)) return;
	if (lstatSync(logPath).isSymbolicLink()) {
		throw new Error(`refusing symlink log path: ${logPath}`);
	}
	hardenRegularFile(logPath);
	if (statSync(logPath).size + incomingBytes <= maxBytes) return;

	const backupPath = `${logPath}.1`;
	if (existsSync(backupPath)) {
		if (lstatSync(backupPath).isSymbolicLink()) {
			throw new Error(`refusing symlink log backup: ${backupPath}`);
		}
		hardenRegularFile(backupPath);
		unlinkSync(backupPath);
	}
	renameSync(logPath, backupPath);
	chmodSync(backupPath, 0o600);
}
