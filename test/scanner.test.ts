import { describe, expect, test } from "bun:test";
import { WindowScanner } from "../src/scanner.ts";
import type { TmuxAdapter } from "../src/tmux-adapter.ts";
import type {
	CommandResult,
	NameCandidate,
	PaneInfo,
	TmuxServerIdentity,
	WindowState,
} from "../src/types.ts";
import { pane, state, testConfig } from "./helpers.ts";

class FakeTmux implements TmuxAdapter {
	public panes: PaneInfo[] = [];
	public states = new Map<string, WindowState>();
	public captured = new Map<string, string[]>();
	public captureCalls: string[] = [];
	public renamed: Array<{ windowId: string; name: string }> = [];
	public managed: Array<{ windowId: string; candidate: NameCandidate }> = [];
	public manual: string[] = [];
	public cleared: string[] = [];
	public cancelledResets: string[] = [];
	public beforeCommit?: () => void;
	public beforeConsume?: () => void;

	listActivePanes(): PaneInfo[] {
		return this.panes;
	}
	readWindowState(windowId: string): WindowState {
		return this.states.get(windowId) ?? state();
	}
	commitCandidate(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
		candidate: NameCandidate,
	): boolean {
		this.beforeCommit?.();
		const current = this.states.get(windowId) ?? state();
		if (
			current.resetPending ||
			current.resetGeneration !== expectedResetGeneration ||
			this.readWindowName(windowId) !== expectedWindowName
		) {
			return false;
		}
		this.managed.push({ windowId, candidate });
		this.renamed.push({ windowId, name: candidate.name });
		this.panes = this.panes.map((pane) =>
			pane.windowId === windowId ? { ...pane, windowName: candidate.name } : pane,
		);
		this.states.set(
			windowId,
			state({
				managed: true,
				locked: candidate.lock,
				lastName: candidate.name,
				source: candidate.source,
				resetGeneration: current.resetGeneration,
			}),
		);
		return true;
	}
	markManual(windowId: string): void {
		this.manual.push(windowId);
	}
	clearWindowState(windowId: string): void {
		this.cleared.push(windowId);
		this.states.set(
			windowId,
			state({ resetGeneration: `cleared-${this.cleared.length}` }),
		);
	}
	requestWindowReset(windowId: string): void {
		const current = this.states.get(windowId) ?? state();
		this.panes = this.panes.map((pane) =>
			pane.windowId === windowId ? { ...pane, windowName: "tmux" } : pane,
		);
		this.states.set(windowId, {
			...current,
			resetGeneration: `requested-${this.cleared.length}`,
			resetPending: true,
		});
	}
	consumeWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean {
		this.beforeConsume?.();
		const current = this.states.get(windowId) ?? state();
		if (
			!current.resetPending ||
			current.resetGeneration !== expectedResetGeneration ||
			this.readWindowName(windowId) !== expectedWindowName
		) {
			return false;
		}
		this.clearWindowState(windowId);
		this.renameWindow(windowId, "tmux");
		return true;
	}
	preserveManualWindowReset(
		windowId: string,
		expectedWindowName: string,
		expectedResetGeneration: string,
	): boolean {
		const current = this.states.get(windowId) ?? state();
		if (
			!current.resetPending ||
			current.resetGeneration !== expectedResetGeneration ||
			this.readWindowName(windowId) !== expectedWindowName
		) {
			return false;
		}
		this.cancelledResets.push(windowId);
		this.states.set(windowId, { ...current, manual: true, resetPending: false });
		this.manual.push(windowId);
		return true;
	}
	readWindowName(windowId: string): string {
		return this.panes.find((pane) => pane.windowId === windowId)?.windowName ?? "";
	}
	renameWindow(windowId: string, name: string): void {
		this.renamed.push({ windowId, name });
		this.panes = this.panes.map((pane) =>
			pane.windowId === windowId ? { ...pane, windowName: name } : pane,
		);
	}
	capturePane(paneId: string): string[] {
		this.captureCalls.push(paneId);
		return this.captured.get(paneId) ?? [];
	}
	readGlobalOption(): string {
		return "";
	}
	setGlobalOption(): void {}
	unsetGlobalOption(): void {}
	displayMessage(): void {}
	currentWindowId(): string {
		return "@1";
	}
	serverIdentity(): TmuxServerIdentity | null {
		return null;
	}
}

function psRun(): CommandResult {
	return {
		stdout: " 100 1 pi pi\n",
		stderr: "",
		exitCode: 0,
	};
}

describe("WindowScanner", () => {
	test("runs scan through fake TmuxAdapter and fake LLM", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.captured.set("%1", [
			"Current working directory: /repo",
			"work on tmux plugin",
			"manual protection bug",
		]);
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "tmux plugin" },
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);
		expect(tmux.renamed).toEqual([{ windowId: "@1", name: "pi:tmux-plugin" }]);
		expect(tmux.managed[0]?.candidate).toEqual({
			name: "pi:tmux-plugin",
			tool: "pi",
			source: "ai",
			lock: true,
		});
		});

	test("drops an AI result when reset happens during the provider request", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.states.set("@1", state({ resetGeneration: "before-reset" }));
		tmux.captured.set("%1", [
			"Current working directory: /repo",
			"work on tmux plugin",
			"reset race",
		]);
		let resolveSlug = (_slug: string): void => undefined;
		const slug = new Promise<string>((resolve) => {
			resolveSlug = resolve;
		});
		let providerStarted = (): void => undefined;
		const started = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		const scanner = new WindowScanner({
			tmux,
			llm: {
				generateSlug: async () => {
					providerStarted();
					return await slug;
				},
			},
			run: psRun,
			log: () => undefined,
		});
		const scan = scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);
		await started;
		tmux.states.set("@1", state({ resetGeneration: "after-reset" }));
		resolveSlug("stale result");
		await scan;

		expect(tmux.renamed).toEqual([]);
		expect(tmux.managed).toEqual([]);
	});

	test("preserves a manual rename made during the provider request", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.captured.set("%1", [
			"Current working directory: /repo",
			"work on tmux plugin",
			"manual rename race",
		]);
		let resolveSlug = (_slug: string): void => undefined;
		const slug = new Promise<string>((resolve) => {
			resolveSlug = resolve;
		});
		let providerStarted = (): void => undefined;
		const started = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		const scanner = new WindowScanner({
			tmux,
			llm: {
				generateSlug: async () => {
					providerStarted();
					return await slug;
				},
			},
			run: psRun,
			log: () => undefined,
		});
		const scan = scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);
		await started;
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "my-manual-name", panePid: 100 }),
		];
		resolveSlug("stale result");
		await scan;

		expect(tmux.manual).toEqual([]);
		expect(tmux.renamed).toEqual([]);
		expect(tmux.managed).toEqual([]);

		await scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);
		expect(tmux.manual).toEqual(["@1"]);
	});

	test("preserves a manual rename immediately before candidate commit", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.captured.set("%1", [
			"Current working directory: /repo",
			"work on tmux plugin",
			"commit race",
		]);
		tmux.beforeCommit = () => {
			tmux.beforeCommit = undefined;
			tmux.panes = [
				pane({
					paneCommand: "pi",
					windowName: "last-second-manual",
					panePid: 100,
				}),
			];
		};
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "tmux plugin" },
			run: psRun,
			log: () => undefined,
		});

		await scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);

		expect(tmux.readWindowName("@1")).toBe("last-second-manual");
		expect(tmux.renamed).toEqual([]);
		expect(tmux.managed).toEqual([]);
	});

	test("consumes a pending reset before normal protection rules", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.states.set(
			"@1",
			state({
				managed: true,
				locked: true,
				manual: true,
				lastName: "pi:stale-name",
				resetGeneration: "requested-reset",
				resetPending: true,
			}),
		);
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "must-not-run" },
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(testConfig());

		expect(tmux.cleared).toEqual(["@1"]);
		expect(tmux.renamed).toEqual([{ windowId: "@1", name: "tmux" }]);
		expect(tmux.states.get("@1")?.resetPending).toBe(false);
		expect(tmux.manual).toEqual([]);
	});

	test("manual rename after reset cancels the pending reset", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "manual-after-reset", panePid: 100 }),
		];
		tmux.states.set(
			"@1",
			state({
				managed: true,
				locked: true,
				lastName: "pi:old-name",
				resetGeneration: "requested-reset",
				resetPending: true,
			}),
		);
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "must-not-run" },
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(testConfig());

		expect(tmux.cancelledResets).toEqual(["@1"]);
		expect(tmux.manual).toEqual(["@1"]);
		expect(tmux.cleared).toEqual([]);
		expect(tmux.renamed).toEqual([]);
	});

	test("does not consume a reset after a last-second manual rename", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "tmux", panePid: 100 }),
		];
		tmux.states.set(
			"@1",
			state({ resetGeneration: "requested-reset", resetPending: true }),
		);
		tmux.beforeConsume = () => {
			tmux.beforeConsume = undefined;
			tmux.panes = [
				pane({
					paneCommand: "pi",
					windowName: "last-second-manual",
					panePid: 100,
				}),
			];
		};
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "must-not-run" },
			run: psRun,
			log: () => undefined,
		});

		await scanner.scanOnce(testConfig());
		expect(tmux.readWindowName("@1")).toBe("last-second-manual");
		expect(tmux.states.get("@1")?.resetPending).toBe(true);
		expect(tmux.cleared).toEqual([]);
		expect(tmux.renamed).toEqual([]);

		await scanner.scanOnce(testConfig());
		expect(tmux.states.get("@1")?.resetPending).toBe(false);
		expect(tmux.manual).toEqual(["@1"]);
		expect(tmux.renamed).toEqual([]);
	});

	test("pending reset consumes a managed result from an older request", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "pi:gap-result", panePid: 100 }),
		];
		tmux.states.set(
			"@1",
			state({
				managed: true,
				locked: true,
				lastName: "pi:gap-result",
				resetGeneration: "requested-reset",
				resetPending: true,
			}),
		);
		const scanner = new WindowScanner({
			tmux,
			llm: { generateSlug: async () => "must-not-run" },
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(testConfig());

		expect(tmux.cleared).toEqual(["@1"]);
		expect(tmux.cancelledResets).toEqual([]);
		expect(tmux.manual).toEqual([]);
		expect(tmux.renamed).toEqual([{ windowId: "@1", name: "tmux" }]);
	});

	test("protects custom unmanaged names through fake TmuxAdapter", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "newspaper", panePid: 100 }),
		];
		tmux.captured.set("%1", [
			"Current working directory: /repo",
			"restore newspaper scan",
			"delivery script",
		]);
		let llmCalls = 0;
		const scanner = new WindowScanner({
			tmux,
			llm: {
				generateSlug: async () => {
					llmCalls += 1;
					return "newspaper restoration";
				},
			},
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(
			testConfig({
				llm: { enabled: true },
				naming: { minNonEmptyLines: 2 },
			}),
		);
		expect(tmux.manual).toEqual(["@1"]);
		expect(tmux.renamed).toEqual([]);
		expect(tmux.captureCalls).toEqual([]);
		expect(llmCalls).toBe(0);
	});

	test("skips locked AI windows before pane capture or LLM", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [
			pane({ paneCommand: "pi", windowName: "pi:tmux-plugin", panePid: 100 }),
		];
		tmux.states.set(
			"@1",
			state({ managed: true, locked: true, lastName: "pi:tmux-plugin" }),
		);
		let llmCalls = 0;
		const scanner = new WindowScanner({
			tmux,
			llm: {
				generateSlug: async () => {
					llmCalls += 1;
					return "should-not-run";
				},
			},
			run: psRun,
			log: () => undefined,
		});
		await scanner.scanOnce(testConfig());
		expect(tmux.captureCalls).toEqual([]);
		expect(llmCalls).toBe(0);
		expect(tmux.renamed).toEqual([]);
		expect(tmux.managed).toEqual([]);
	});

	test("does not capture panes or call the provider when LLM naming is off", async () => {
		const tmux = new FakeTmux();
		tmux.panes = [pane({ paneCommand: "pi", panePid: 100 })];
		let llmCalls = 0;
		const scanner = new WindowScanner({
			tmux,
			llm: {
				generateSlug: async () => {
					llmCalls += 1;
					return "must-not-run";
				},
			},
			run: psRun,
			log: () => undefined,
		});

		await scanner.scanOnce(testConfig());
		expect(tmux.captureCalls).toEqual([]);
		expect(llmCalls).toBe(0);
	});
});
