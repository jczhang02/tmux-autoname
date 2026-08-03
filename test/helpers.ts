import { DEFAULT_CONFIG } from "../src/config-codec.ts";
import type {
	Config,
	LlmConfig,
	NameCandidate,
	NamingConfig,
	PaneInfo,
	ProcInfo,
	ToolsConfig,
	WindowState,
} from "../src/types.ts";

interface ConfigOverrides {
	llm?: Partial<LlmConfig>;
	naming?: Partial<NamingConfig>;
	tools?: Partial<ToolsConfig>;
}

export function testConfig(overrides: ConfigOverrides = {}): Config {
	return {
		llm: { ...DEFAULT_CONFIG.llm, ...overrides.llm },
		naming: { ...DEFAULT_CONFIG.naming, ...overrides.naming },
		tools: { ...DEFAULT_CONFIG.tools, ...overrides.tools },
	};
}

export function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
	return {
		sessionName: "main",
		windowId: "@1",
		windowIndex: "1",
		windowName: "tmux",
		paneId: "%1",
		paneActive: true,
		paneCommand: "zsh",
		panePath: "/workspace/tmux-autoname",
		panePid: 100,
		paneTitle: "tmux",
		...overrides,
	};
}

export function state(overrides: Partial<WindowState> = {}): WindowState {
	return {
		managed: false,
		locked: false,
		manual: false,
		lastName: "",
		source: "",
		resetGeneration: "",
		resetPending: false,
		...overrides,
	};
}

export function candidate(
	overrides: Partial<NameCandidate> = {},
): NameCandidate {
	return {
		name: "shell:tmux-autoname",
		tool: "shell",
		source: "shell",
		lock: false,
		...overrides,
	};
}

export function proc(overrides: Partial<ProcInfo> = {}): ProcInfo {
	return {
		pid: 101,
		ppid: 100,
		comm: "zsh",
		args: "zsh",
		...overrides,
	};
}
