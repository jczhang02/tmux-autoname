import { describe, expect, test } from "bun:test";
import { heuristicCandidate, testTarget } from "../src/heuristic-namer.ts";
import type { CommandResult } from "../src/types.ts";
import { pane, proc, testConfig } from "./helpers.ts";

const fakeGit =
	(repo = "/workspace/tmux-autoname") =>
	(): CommandResult => ({ stdout: `${repo}\n`, stderr: "", exitCode: 0 });

describe("heuristic namer", () => {
	test("shell candidate uses git root", () => {
		const candidate = heuristicCandidate(
			pane({ paneCommand: "zsh", panePath: "/workspace/tmux-autoname/src" }),
			proc({ comm: "zsh", args: "zsh" }),
			testConfig(),
			fakeGit(),
		);
		expect(candidate?.name).toBe("shell:tmux-autoname");
		expect(candidate?.source).toBe("shell");
		expect(candidate?.lock).toBe(false);
	});

	test("uv run pytest candidate targets test path", () => {
		const candidate = heuristicCandidate(
			pane({ paneCommand: "uv" }),
			proc({ comm: "uv", args: "uv run pytest tests/test_auth.py" }),
			testConfig(),
			fakeGit(),
		);
		expect(candidate?.name).toBe("pytest:auth");
		expect(candidate?.source).toBe("test");
	});

	test("editor candidate uses file argument", () => {
		const candidate = heuristicCandidate(
			pane({ paneCommand: "nvim" }),
			proc({ comm: "nvim", args: "nvim README.md" }),
			testConfig(),
			fakeGit(),
		);
		expect(candidate?.name).toBe("nvim:readme-md");
		expect(candidate?.source).toBe("editor");
	});

	test("testTarget supports -k selector", () => {
		expect(testTarget(["-k", "manual_rename"])).toBe("manual_rename");
	});
});
