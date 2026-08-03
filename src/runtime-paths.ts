import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RuntimePaths {
	stateDir: string;
	logPath: string;
}

export function currentUid(): number {
	const getuid = process.getuid;
	if (!getuid) throw new Error("tmux-autoname requires a Unix-like system");
	return getuid.call(process);
}

export function runtimePaths(
	env: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
	const requestedHome = env.HOME?.trim();
	const home = requestedHome && isAbsolute(requestedHome) ? requestedHome : homedir();
	const requestedStateHome = env.XDG_STATE_HOME?.trim();
	const stateHome =
		requestedStateHome && isAbsolute(requestedStateHome)
			? requestedStateHome
			: join(home, ".local", "state");
	const stateDir = join(stateHome, "tmux-autoname");
	return {
		stateDir,
		logPath: join(stateDir, "daemon.log"),
	};
}

export function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!statSync(path).isDirectory()) {
		throw new Error(`path is not a directory: ${path}`);
	}
	chmodSync(path, 0o700);
}

export function hardenRegularFile(path: string): void {
	if (!existsSync(path)) return;
	if (!statSync(path).isFile()) {
		throw new Error(`path is not a regular file: ${path}`);
	}
	chmodSync(path, 0o600);
}

export function ensurePrivateRuntimeDirectory(path: string): void {
	if (!existsSync(path)) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const entry = lstatSync(path);
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new Error(`runtime path is not a real directory: ${path}`);
	}
	if (entry.uid !== currentUid()) {
		throw new Error(`runtime path has the wrong owner: ${path}`);
	}
	chmodSync(path, 0o700);
}
