import {
	detectAiTool,
	type LlmSlugAdapter,
	createAiCandidate,
} from "./ai-namer.ts";
import type { CommandRunner } from "./command.ts";
import { heuristicCandidate } from "./heuristic-namer.ts";
import { decideWindowAction } from "./naming-engine.ts";
import {
	readProcessSnapshot,
	resolveActiveProcess,
} from "./process-tree-resolver.ts";
import type { TmuxAdapter } from "./tmux-adapter.ts";
import type {
	Config,
	Logger,
	NameCandidate,
	PaneInfo,
	ProcInfo,
} from "./types.ts";

export interface WindowScannerDependencies {
	tmux: TmuxAdapter;
	llm: LlmSlugAdapter;
	run: CommandRunner;
	log: Logger;
}

export class WindowScanner {
	constructor(private readonly deps: WindowScannerDependencies) {}

	async scanOnce(
		config: Config,
		onlyWindowId?: string,
		force = false,
		signal?: AbortSignal,
		isServerCurrent?: () => boolean,
	): Promise<void> {
		const panes = this.deps.tmux
			.listActivePanes()
			.filter((pane) => !onlyWindowId || pane.windowId === onlyWindowId);
		const processTable = readProcessSnapshot(this.deps.run);
		for (const pane of panes) {
			if (signal?.aborted || isServerCurrent?.() === false) break;
			try {
				const proc = resolveActiveProcess(pane, processTable, config);
				await this.processWindow(
					pane,
					proc,
					config,
					force,
					signal,
					isServerCurrent,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.log(`window ${pane.windowId} failed: ${message}`);
			}
		}
	}

	private async processWindow(
		pane: PaneInfo,
		proc: ProcInfo | null,
		config: Config,
		force: boolean,
		signal?: AbortSignal,
		isServerCurrent?: () => boolean,
	): Promise<void> {
		let currentPane = pane;
		let state = this.deps.tmux.readWindowState(pane.windowId);
		let effectiveForce = force;
		if (state.resetPending) {
			const liveWindowName = this.deps.tmux.readWindowName(pane.windowId);
			const isPluginManagedName =
				state.managed &&
				state.lastName.length > 0 &&
				liveWindowName === state.lastName;
			if (liveWindowName !== "tmux" && !isPluginManagedName) {
				if (
					this.deps.tmux.preserveManualWindowReset(
						pane.windowId,
						liveWindowName,
						state.resetGeneration,
					)
				) {
					this.deps.log(`manual rename detected ${pane.windowId}`);
				}
				return;
			}
			if (
				!this.deps.tmux.consumeWindowReset(
					pane.windowId,
					liveWindowName,
					state.resetGeneration,
				)
			) {
				return;
			}
			currentPane = { ...pane, windowName: "tmux" };
			state = this.deps.tmux.readWindowState(pane.windowId);
			effectiveForce = true;
			this.deps.log(`applied pending reset ${pane.windowId}`);
		}
		const aiTool = detectAiTool(currentPane, proc, config);
		const preAction = decideWindowAction({
			pane: currentPane,
			state,
			candidate: null,
			detectedTool: aiTool,
			config,
			force: effectiveForce,
		});
		if (preAction.type === "mark-manual") {
			this.deps.tmux.markManual(pane.windowId);
			this.deps.log(preAction.message);
			return;
		}
		if (
			preAction.type === "noop" &&
			(preAction.reason === "manual protected" || preAction.reason === "locked")
		) {
			return;
		}

		const candidate = await this.createCandidate(
			currentPane,
			proc,
			config,
			aiTool,
			signal,
			isServerCurrent,
		);
		if (signal?.aborted || isServerCurrent?.() === false) return;
		if (candidate?.source === "ai") {
			const liveState = this.deps.tmux.readWindowState(pane.windowId);
			if (
				liveState.resetPending ||
				liveState.resetGeneration !== state.resetGeneration
			) {
				return;
			}
		}
		const action = decideWindowAction({
			pane: currentPane,
			state,
			candidate,
			config,
			force: effectiveForce,
		});

		if (action.type === "noop") return;
		if (action.type === "mark-manual") {
			this.deps.tmux.markManual(pane.windowId);
			this.deps.log(action.message);
			return;
		}

		if (isServerCurrent?.() === false) return;
		if (
			this.deps.tmux.commitCandidate(
				pane.windowId,
				currentPane.windowName,
				state.resetGeneration,
				action.candidate,
			)
		) {
			this.deps.log(action.message);
		}
	}

	private async createCandidate(
		pane: PaneInfo,
		proc: ProcInfo | null,
		config: Config,
		aiTool: string | null,
		signal?: AbortSignal,
		isServerCurrent?: () => boolean,
	): Promise<NameCandidate | null> {
		if (aiTool) {
			if (!config.llm.enabled) return null;
			if (signal?.aborted || isServerCurrent?.() === false) return null;
			return await createAiCandidate(
				pane,
				aiTool,
				this.deps.tmux.capturePane(pane.paneId),
				config,
				this.deps.llm,
				this.deps.log,
				signal,
			);
		}
		return heuristicCandidate(pane, proc, config, this.deps.run);
	}
}
