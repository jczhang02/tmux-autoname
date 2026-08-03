export interface LlmConfig {
	enabled: boolean;
	provider: string;
	model: string;
	thinking: string;
	timeoutSeconds: number;
}

export interface NamingConfig {
	maxLen: number;
	pollSeconds: number;
	minNonEmptyLines: number;
	headLines: number;
	tailLines: number;
}

export interface ToolsConfig {
	ai: string[];
	shells: string[];
	editors: string[];
}

export interface Config {
	llm: LlmConfig;
	naming: NamingConfig;
	tools: ToolsConfig;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface CommandOptions {
	maxBuffer?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ProcessIdentity {
	pid: number;
	startTicks: string;
}

export interface TmuxServerIdentity extends ProcessIdentity {
	socketPath: string;
}

export interface PaneInfo {
	sessionName: string;
	windowId: string;
	windowIndex: string;
	windowName: string;
	paneId: string;
	paneActive: boolean;
	paneCommand: string;
	panePath: string;
	panePid: number;
	paneTitle: string;
}

export interface ProcInfo {
	pid: number;
	ppid: number;
	comm: string;
	args: string;
}

export interface WindowState {
	managed: boolean;
	locked: boolean;
	manual: boolean;
	lastName: string;
	source: string;
	resetGeneration: string;
	resetPending: boolean;
}

export type CandidateSource = "ai" | "editor" | "test" | "build" | "shell";

export interface NameCandidate {
	name: string;
	tool: string;
	source: CandidateSource;
	lock: boolean;
}

export type Logger = (message: string) => void;
