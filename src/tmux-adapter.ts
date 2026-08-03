import { randomUUID } from "node:crypto";
import type { CommandRunner } from "./command.ts";
import { processStartTicks } from "./command.ts";
import type {
	CommandResult,
	NameCandidate,
	PaneInfo,
	TmuxServerIdentity,
	WindowState,
} from "./types.ts";

const WINDOW_STATE_KEYS = [
	"@autoname_managed",
	"@autoname_locked",
	"@autoname_manual",
	"@autoname_last_name",
	"@autoname_source",
	"@autoname_reset_pending",
] as const;
const RESET_GENERATION_OPTION = "@autoname_reset_generation";
const RESET_PENDING_OPTION = "@autoname_reset_pending";
const CAS_EXPECTED_NAME_OPTION = "@autoname_cas_expected_name";
const CAS_EXPECTED_GENERATION_OPTION = "@autoname_cas_expected_generation";
const CAS_APPLIED = "TMUX_AUTONAME_CAS_APPLIED";
const CAS_SKIPPED = "TMUX_AUTONAME_CAS_SKIPPED";

export interface TmuxAdapter {
	listActivePanes(): PaneInfo[];
	readWindowState(windowId: string): WindowState;
	commitCandidate(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
		candidate: NameCandidate,
	): boolean;
	markManual(windowId: string): void;
	clearWindowState(windowId: string): void;
	requestWindowReset(windowId: string): void;
	consumeWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean;
	preserveManualWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean;
	readWindowName(windowId: string): string;
	renameWindow(windowId: string, name: string): void;
	capturePane(paneId: string): string[];
	readGlobalOption(key: string): string;
	setGlobalOption(key: string, value: string): void;
	unsetGlobalOption(key: string): void;
	displayMessage(message: string): void;
	currentWindowId(): string;
	serverIdentity(): TmuxServerIdentity | null;
}

export class TmuxCliAdapter implements TmuxAdapter {
	constructor(
		private readonly run: CommandRunner,
		private readonly readStartTicks: (pid: number) => string | null =
			processStartTicks,
	) {}

	listActivePanes(): PaneInfo[] {
		const format = [
			"#{session_name}",
			"#{window_id}",
			"#{window_index}",
			"#{window_name}",
			"#{pane_id}",
			"#{pane_active}",
			"#{pane_current_command}",
			"#{pane_current_path}",
			"#{pane_pid}",
			"#{pane_title}",
		].join("\t");
		const result = this.tmux(["list-panes", "-a", "-F", format]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr.trim() || "tmux list-panes failed");

		return result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("\t"))
			.filter((fields) => fields.length >= 10 && fields[5] === "1")
			.map((fields) => ({
				sessionName: fields[0] ?? "",
				windowId: fields[1] ?? "",
				windowIndex: fields[2] ?? "",
				windowName: fields[3] ?? "",
				paneId: fields[4] ?? "",
				paneActive: fields[5] === "1",
				paneCommand: fields[6] ?? "",
				panePath: fields[7] ?? "",
				panePid: Number(fields[8] ?? "0"),
				paneTitle: fields.slice(9).join("\t"),
			}))
			.filter(
				(pane) => pane.windowId.length > 0 && Number.isFinite(pane.panePid),
			);
	}

	readWindowState(windowId: string): WindowState {
		const result = this.tmux(["show-options", "-wq", "-t", windowId]);
		const values = new Map<string, string>();
		if (result.exitCode === 0) {
			for (const line of result.stdout.split("\n")) {
				const match = line.match(/^(@autoname_[^\s]+)\s*(.*)$/);
				if (!match) continue;
				values.set(match[1] ?? "", match[2] ?? "");
			}
		}
		return {
			managed: values.get("@autoname_managed") === "1",
			locked: values.get("@autoname_locked") === "1",
			manual: values.get("@autoname_manual") === "1",
			lastName: values.get("@autoname_last_name") ?? "",
			source: values.get("@autoname_source") ?? "",
			resetGeneration: values.get(RESET_GENERATION_OPTION) ?? "",
			resetPending: values.get(RESET_PENDING_OPTION) === "1",
		};
	}

	commitCandidate(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
		candidate: NameCandidate,
	): boolean {
		const target = commandAtom(windowId, "window id", /^@\d+$/);
		const name = commandAtom(candidate.name, "candidate name", /^[a-z0-9:-]+$/);
		const source = commandAtom(candidate.source, "candidate source", /^[a-z]+$/);
		const lockCommand = candidate.lock
			? `set-option -wq -t ${target} @autoname_locked 1`
			: `set-option -wq -u -t ${target} @autoname_locked`;
		return this.conditionalWindowUpdate(
			windowId,
			expectedWindowName,
			expectedResetGeneration,
			false,
			[
				`rename-window -t ${target} ${name}`,
				`set-option -wq -t ${target} @autoname_managed 1`,
				`set-option -wq -t ${target} @autoname_last_name ${name}`,
				`set-option -wq -t ${target} @autoname_source ${source}`,
				lockCommand,
				`set-option -wq -u -t ${target} @autoname_manual`,
			],
		);
	}

	markManual(windowId: string): void {
		this.setWindowOption(windowId, "@autoname_manual", "1");
	}

	clearWindowState(windowId: string): void {
		const result = this.tmux([
			"set-option",
			"-wq",
			"-t",
			windowId,
			RESET_GENERATION_OPTION,
			randomUUID(),
			...WINDOW_STATE_KEYS.flatMap((key) => [
				";",
				"set-option",
				"-wq",
				"-u",
				"-t",
				windowId,
				key,
			]),
		]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `clear state ${windowId} failed`);
		}
	}

	requestWindowReset(windowId: string): void {
		const result = this.tmux([
			"set-option",
			"-wq",
			"-t",
			windowId,
			RESET_GENERATION_OPTION,
			randomUUID(),
			";",
			"rename-window",
			"-t",
			windowId,
			"tmux",
			...WINDOW_STATE_KEYS.filter((key) => key !== RESET_PENDING_OPTION).flatMap(
				(key) => [
					";",
					"set-option",
					"-wq",
					"-u",
					"-t",
					windowId,
					key,
				],
			),
			";",
			"set-option",
			"-wq",
			"-t",
			windowId,
			RESET_PENDING_OPTION,
			"1",
		]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `request reset ${windowId} failed`);
		}
	}

	consumeWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean {
		const target = commandAtom(windowId, "window id", /^@\d+$/);
		return this.conditionalWindowUpdate(
			windowId,
			expectedWindowName,
			expectedResetGeneration,
			true,
			[
				`set-option -wq -t ${target} ${RESET_GENERATION_OPTION} ${randomUUID()}`,
				...WINDOW_STATE_KEYS.map(
					(key) => `set-option -wq -u -t ${target} ${key}`,
				),
				`rename-window -t ${target} tmux`,
			],
		);
	}

	preserveManualWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean {
		const target = commandAtom(windowId, "window id", /^@\d+$/);
		return this.conditionalWindowUpdate(
			windowId,
			expectedWindowName,
			expectedResetGeneration,
			true,
			[
				`set-option -wq -u -t ${target} ${RESET_PENDING_OPTION}`,
				`set-option -wq -t ${target} @autoname_manual 1`,
			],
		);
	}

	readWindowName(windowId: string): string {
		const result = this.tmux([
			"display-message",
			"-p",
			"-t",
			windowId,
			"#{window_name}",
		]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `read window name ${windowId} failed`);
		}
		return result.stdout.trimEnd();
	}

	renameWindow(windowId: string, name: string): void {
		const result = this.tmux(["rename-window", "-t", windowId, name]);
		if (result.exitCode !== 0)
			throw new Error(
				result.stderr.trim() || `rename-window ${windowId} failed`,
			);
	}

	capturePane(paneId: string): string[] {
		const result = this.tmux([
			"capture-pane",
			"-pJ",
			"-t",
			paneId,
			"-S",
			"-1000",
		]);
		if (result.exitCode !== 0) return [];
		return result.stdout.split("\n");
	}

	readGlobalOption(key: string): string {
		const result = this.tmux(["show-option", "-gqv", key]);
		return result.exitCode === 0 ? result.stdout.trim() : "";
	}

	setGlobalOption(key: string, value: string): void {
		this.tmux(["set-option", "-gq", key, value]);
	}

	unsetGlobalOption(key: string): void {
		this.tmux(["set-option", "-gqu", key]);
	}

	displayMessage(message: string): void {
		this.tmux(["display-message", message]);
	}

	currentWindowId(): string {
		return this.tmux(["display-message", "-p", "#{window_id}"]).stdout.trim();
	}

	serverIdentity(): TmuxServerIdentity | null {
		const result = this.tmux([
			"display-message",
			"-p",
			"#{socket_path}\t#{pid}",
		]);
		if (result.exitCode !== 0) return null;
		const [socketPath = "", pidText = ""] = result.stdout.trim().split("\t");
		const pid = Number(pidText);
		if (!socketPath || !Number.isInteger(pid) || pid <= 1) return null;
		const startTicks = this.readStartTicks(pid);
		return startTicks ? { socketPath, pid, startTicks } : null;
	}

	private setWindowOption(windowId: string, key: string, value: string): void {
		this.tmux(["set-option", "-wq", "-t", windowId, key, value]);
	}

	private conditionalWindowUpdate(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
		expectedPending: boolean,
		commands: string[],
	): boolean {
		const target = commandAtom(windowId, "window id", /^@\d+$/);
		const pendingCondition = expectedPending
			? `#{==:#{${RESET_PENDING_OPTION}},1}`
			: `#{!=:#{${RESET_PENDING_OPTION}},1}`;
		const condition = `#{&&:#{==:#{window_name},#{${CAS_EXPECTED_NAME_OPTION}}},#{&&:#{==:#{${RESET_GENERATION_OPTION}},#{${CAS_EXPECTED_GENERATION_OPTION}}},${pendingCondition}}}`;
		const cleanup = [
			`set-option -wq -u -t ${target} ${CAS_EXPECTED_NAME_OPTION}`,
			`set-option -wq -u -t ${target} ${CAS_EXPECTED_GENERATION_OPTION}`,
		];
		const appliedCommands = [...commands, ...cleanup, `display-message -p -t ${target} ${CAS_APPLIED}`].join(
			" ; ",
		);
		const skippedCommands = [...cleanup, `display-message -p -t ${target} ${CAS_SKIPPED}`].join(
			" ; ",
		);
		const result = this.tmux([
			"set-option",
			"-wq",
			"-t",
			windowId,
			CAS_EXPECTED_NAME_OPTION,
			expectedWindowName,
			";",
			"set-option",
			"-wq",
			"-t",
			windowId,
			CAS_EXPECTED_GENERATION_OPTION,
			expectedResetGeneration,
			";",
			"if-shell",
			"-F",
			"-t",
			windowId,
			condition,
			appliedCommands,
			skippedCommands,
		]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `conditional update ${windowId} failed`);
		}
		return result.stdout.trim() === CAS_APPLIED;
	}

	private tmux(args: string[]): CommandResult {
		return this.run(["tmux", ...args]);
	}
}

function commandAtom(value: string, label: string, pattern: RegExp): string {
	if (!pattern.test(value)) throw new Error(`invalid ${label}: ${value}`);
	return value;
}
