import { describe, expect, test } from "bun:test";
import {
	decideWindowAction,
	isGenericWindowName,
} from "../src/naming-engine.ts";
import { candidate, pane, state, testConfig } from "./helpers.ts";

describe("NamingEngine", () => {
	test("manual protected window is not touched", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "newspaper" }),
			state: state({ manual: true }),
			candidate: candidate({ name: "pi:newspaper-restoration" }),
			config: testConfig(),
			force: false,
		});
		expect(action).toEqual({ type: "noop", reason: "manual protected" });
	});

	test("managed window renamed by user becomes manual", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "newspaper" }),
			state: state({ managed: true, lastName: "pi:old-name" }),
			candidate: candidate({ name: "pi:newspaper-restoration" }),
			config: testConfig(),
			force: false,
		});
		expect(action.type).toBe("mark-manual");
		if (action.type !== "mark-manual") throw new Error("expected mark-manual");
		expect(action.message).toContain("manual rename detected @1");
	});

	test("locked AI window is not renamed", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "pi:stable" }),
			state: state({ managed: true, locked: true, lastName: "pi:stable" }),
			candidate: candidate({ name: "pi:new-work", source: "ai", lock: true }),
			config: testConfig(),
			force: false,
		});
		expect(action).toEqual({ type: "noop", reason: "locked" });
	});

	test("exact tmux name is generic, not manual custom", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "tmux", paneCommand: "pi" }),
			state: state(),
			candidate: candidate({
				name: "pi:tmux-plugin",
				tool: "pi",
				source: "ai",
				lock: true,
			}),
			config: testConfig(),
			force: false,
		});
		expect(action.type).toBe("apply-candidate");
		if (action.type === "apply-candidate") {
			expect(action.rename).toBe(true);
			expect(action.candidate.name).toBe("pi:tmux-plugin");
		}
	});

	test("existing business name is protected as manual", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "newspaper" }),
			state: state(),
			candidate: candidate({
				name: "pi:newspaper-restoration",
				tool: "pi",
				source: "ai",
				lock: true,
			}),
			config: testConfig(),
			force: false,
		});
		expect(action.type).toBe("mark-manual");
		if (action.type !== "mark-manual") throw new Error("expected mark-manual");
		expect(action.message).toContain("protect existing custom name");
	});

	test("detected AI tools protect custom names before a candidate exists", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "my-manual-name", paneCommand: "pi" }),
			state: state(),
			candidate: null,
			detectedTool: "pi",
			config: testConfig(),
			force: false,
		});
		expect(action.type).toBe("mark-manual");
	});

	test("force reset applies candidate despite manual state", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "newspaper" }),
			state: state({ manual: true }),
			candidate: candidate({
				name: "pi:newspaper-restoration",
				tool: "pi",
				source: "ai",
				lock: true,
			}),
			config: testConfig(),
			force: true,
		});
		expect(action.type).toBe("apply-candidate");
	});

	test("unchanged managed metadata is a no-op", () => {
		const action = decideWindowAction({
			pane: pane({ windowName: "shell:dotfiles" }),
			state: state({
				managed: true,
				lastName: "shell:dotfiles",
				source: "shell",
			}),
			candidate: candidate({
				name: "shell:dotfiles",
				source: "shell",
				lock: false,
			}),
			config: testConfig(),
			force: false,
		});
		expect(action).toEqual({ type: "noop", reason: "already current" });
	});

	test("generic helper recognizes process and shell names", () => {
		const config = testConfig();
		expect(isGenericWindowName("tmux", pane(), "shell", config)).toBe(true);
		expect(isGenericWindowName("zsh", pane(), "shell", config)).toBe(true);
		expect(isGenericWindowName("newspaper", pane(), "pi", config)).toBe(false);
	});
});
