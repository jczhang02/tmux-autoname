import { commandKey } from "./command.ts";
import type { Config, NameCandidate, PaneInfo, WindowState } from "./types.ts";

export type WindowAction =
	| { type: "noop"; reason: string }
	| { type: "mark-manual"; message: string }
	| {
			type: "apply-candidate";
			candidate: NameCandidate;
			rename: boolean;
			message: string;
	  };

export interface NamingDecisionInput {
	pane: PaneInfo;
	state: WindowState;
	candidate: NameCandidate | null;
	detectedTool?: string | null;
	config: Config;
	force: boolean;
}

export function decideWindowAction(input: NamingDecisionInput): WindowAction {
	const { pane, state, candidate, config, force } = input;

	if (!force && state.manual)
		return { type: "noop", reason: "manual protected" };
	if (
		!force &&
		state.managed &&
		state.lastName &&
		pane.windowName !== state.lastName
	) {
		return {
			type: "mark-manual",
			message: `manual rename detected ${pane.windowId}`,
		};
	}
	if (!force && state.locked && state.lastName)
		return { type: "noop", reason: "locked" };

	const detectedTool = candidate?.tool ?? input.detectedTool;
	if (
		!force &&
		!state.managed &&
		detectedTool &&
		!isGenericWindowName(pane.windowName, pane, detectedTool, config)
	) {
		return {
			type: "mark-manual",
			message: `protect existing custom name ${pane.windowId}`,
		};
	}
	if (!candidate) return { type: "noop", reason: "no candidate" };
	if (
		state.managed &&
		pane.windowName === candidate.name &&
		state.lastName === candidate.name &&
		state.source === candidate.source &&
		state.locked === candidate.lock
	) {
		return { type: "noop", reason: "already current" };
	}

	return {
		type: "apply-candidate",
		candidate,
		rename: pane.windowName !== candidate.name,
		message: `${pane.windowName !== candidate.name ? "renamed" : "updated"} ${pane.windowId} (${candidate.source})`,
	};
}

export function isGenericWindowName(
	name: string,
	pane: PaneInfo,
	tool: string,
	config: Config,
): boolean {
	const key = commandKey(name);
	const paneKey = commandKey(pane.paneCommand);
	if (name.trim().length === 0) return true;
	if (key === tool || key === paneKey) return true;
	if (name.startsWith("π:") || name.includes("…")) return true;
	if (/^\d+\.\d+(\.\d+)?$/.test(name)) return true;
	if (config.tools.shells.includes(key) || config.tools.editors.includes(key))
		return true;
	if (
		[
			"tmux",
			"pytest",
			"cargo",
			"bun",
			"npm",
			"pnpm",
			"uv",
			"python",
			"node",
		].includes(key)
	)
		return true;
	return false;
}
