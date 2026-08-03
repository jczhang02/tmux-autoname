import { describe, expect, test } from "bun:test";
import {
	processIdentity,
	processMatches,
	run,
	runAsync,
} from "../src/command.ts";

describe("command runner", () => {
	test("caps captured provider output", () => {
		const result = run(
			[
				process.execPath,
				"-e",
				'process.stdout.write("x".repeat(1024 * 1024))',
			],
			undefined,
			undefined,
			{ maxBuffer: 1024 },
		);
		expect(result.exitCode).not.toBe(0);
		expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
	});

	test("enforces command timeouts", () => {
		const startedAt = performance.now();
		const result = run(
			[process.execPath, "-e", "Bun.sleepSync(10_000)"],
			undefined,
			undefined,
			{ timeoutMs: 20 },
		);
		expect(result.exitCode).not.toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(1000);
	});

	test("async commands are cancelled through AbortSignal", async () => {
		const controller = new AbortController();
		const startedAt = performance.now();
		const running = runAsync(
			[process.execPath, "-e", "await Bun.sleep(10_000)"],
			undefined,
			undefined,
			{ signal: controller.signal },
		);
		await Bun.sleep(20);
		controller.abort();
		const result = await running;
		expect(result.exitCode).not.toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(1000);
	});

	test("async commands cap returned output", async () => {
		const result = await runAsync(
			[
				process.execPath,
				"-e",
				'process.stdout.write("x".repeat(1024 * 1024))',
			],
			undefined,
			undefined,
			{ maxBuffer: 1024 },
		);
		expect(result.exitCode).not.toBe(0);
		expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
	});

	test("process identities detect the current process", () => {
		const identity = processIdentity(process.pid);
		expect(identity).not.toBeNull();
		if (identity) expect(processMatches(identity)).toBe(true);
	});
});
