import { commandKey, type CommandRunner } from "./command.ts";
import type { Config, PaneInfo, ProcInfo } from "./types.ts";

export type ProcessSnapshot = Map<number, ProcInfo>;

export function readProcessSnapshot(run: CommandRunner): ProcessSnapshot {
	const result = run(["ps", "-eo", "pid=,ppid=,comm=,args="]);
	const table: ProcessSnapshot = new Map();
	if (result.exitCode !== 0) return table;

	for (const line of result.stdout.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const comm = match[3] ?? "";
		const args = match[4] ?? comm;
		table.set(pid, { pid, ppid, comm, args });
	}
	return table;
}

export function resolveActiveProcess(
	pane: PaneInfo,
	snapshot: ProcessSnapshot,
	config: Config,
): ProcInfo | null {
	const children = childIndex(snapshot);
	const descendants = descendantsFrom(pane.panePid, snapshot, children);
	const paneCommand = commandKey(pane.paneCommand);
	if (!config.tools.shells.includes(paneCommand)) {
		const matching = descendants
			.filter((item) => commandKey(item.proc.comm) === paneCommand)
			.sort((a, b) => b.depth - a.depth)[0];
		if (matching) return matching.proc;
	}

	const nonShell = descendants
		.filter((item) => !config.tools.shells.includes(commandKey(item.proc.comm)))
		.filter((item) => commandKey(item.proc.comm) !== "tmux")
		.sort((a, b) => b.depth - a.depth)[0];
	if (nonShell) return nonShell.proc;

	return (
		descendants
			.filter((item) => commandKey(item.proc.comm) !== "tmux")
			.sort((a, b) => b.depth - a.depth)[0]?.proc ?? null
	);
}

function childIndex(snapshot: ProcessSnapshot): Map<number, ProcInfo[]> {
	const children = new Map<number, ProcInfo[]>();
	for (const proc of snapshot.values()) {
		const list = children.get(proc.ppid) ?? [];
		list.push(proc);
		children.set(proc.ppid, list);
	}
	return children;
}

function descendantsFrom(
	rootPid: number,
	snapshot: ProcessSnapshot,
	children: Map<number, ProcInfo[]>,
): Array<{ proc: ProcInfo; depth: number }> {
	const queue: Array<{ proc: ProcInfo; depth: number }> = [];
	const root = snapshot.get(rootPid);
	if (root) queue.push({ proc: root, depth: 0 });
	for (const child of children.get(rootPid) ?? [])
		queue.push({ proc: child, depth: 1 });

	const seen = new Set<number>();
	const descendants: Array<{ proc: ProcInfo; depth: number }> = [];
	while (queue.length > 0) {
		const item = queue.shift();
		if (!item || seen.has(item.proc.pid)) continue;
		seen.add(item.proc.pid);
		descendants.push(item);
		for (const child of children.get(item.proc.pid) ?? []) {
			queue.push({ proc: child, depth: item.depth + 1 });
		}
	}
	return descendants;
}
