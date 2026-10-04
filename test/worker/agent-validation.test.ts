import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FlightSandbox } from "../../src/worker/agents/flight-sandbox.ts";
import { TEST_COMMAND, validationResult } from "../../src/worker/agents/validation.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
}));

describe("sandbox validation process evidence", () => {
	it.each([0, 7, 124])("preserves command exit %i despite tail succeeding", (exitCode) => {
		const dir = mkdtempSync(join(tmpdir(), "cruce-test-exit-"));
		try {
			writeFileSync(join(dir, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
			writeFileSync(join(dir, "npm"), `#!/bin/sh\nprintf 'ℹ pass 9\\nℹ fail 0\\n'\nexit ${exitCode}\n`, { mode: 0o755 });
			const result = spawnSync("/bin/sh", ["-c", TEST_COMMAND, "tests", join(dir, "tests.log")], {
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
				encoding: "utf8",
			});
			expect(result.status).toBe(exitCode);
			expect(validationResult(result.status as number, result.stdout).passed).toBe(exitCode === 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails empty nonzero output and reports timeouts explicitly", () => {
		expect(validationResult(1, "").passed).toBe(false);
		expect(validationResult(124, "")).toEqual({ passed: false, summary: "test command timed out (npm test in sandbox)" });
		expect(validationResult(0, "a test named error passes").passed).toBe(true);
	});

	it("refuses validation when the sandbox repository has no test script", async () => {
		const sandbox = new FlightSandbox({} as DurableObjectState, {} as never);
		const internals = sandbox as unknown as {
			start(): Promise<void>;
			run(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
		};
		vi.spyOn(internals, "start").mockResolvedValue();
		const run = vi.spyOn(internals, "run").mockResolvedValue({ exitCode: 0, stdout: "false\n", stderr: "" });
		expect(await sandbox.runTests()).toEqual({ passed: false, summary: "Missing test script: validation could not run" });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("also treats a missing npm test script as failure in the external runner", () => {
		const dir = mkdtempSync(join(tmpdir(), "cruce-missing-test-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "missing-test", private: true }));
			const result = spawnSync("npm", ["test"], { cwd: dir, encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Missing script: "test"');
			expect(validationResult(result.status as number, result.stderr).passed).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
