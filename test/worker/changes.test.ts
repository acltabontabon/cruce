import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../src/core/domain.ts";
import { DEMO_SCRIPT, initialDemoStatus, runNextStep } from "../../src/worker/demo-director.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { ProjectGit } from "../../src/worker/project-git.ts";
import { Tower } from "../../src/worker/tower.ts";

async function setup() {
	const store = new Map<string, unknown>();
	const project: ProjectInfo = {
		id: "demo",
		name: "auth-service",
		repo: "auth-service",
		namespace: "local",
		defaultBranch: "main",
		mode: "demo",
		gitBackend: "simulated",
	};
	const ws = new GitWorkspace(new MemoryFs() as never);
	const git = new ProjectGit(ws, project.repo);
	const tower = new Tower(
		project,
		git,
		{
			get: <T>(key: string) => structuredClone(store.get(key)) as T,
			put: (key, value) => {
				store.set(key, structuredClone(value));
			},
			delete: (key) => {
				store.delete(key);
			},
			appendEvents: () => {},
		},
		{ onChange: () => {} },
		() => 1000,
		21,
	);
	await tower.bootstrap();
	let status = initialDemoStatus();
	const runTo = async (id: string) => {
		while (status.next < DEMO_SCRIPT.length && DEMO_SCRIPT[status.next - 1]?.id !== id) {
			status = await runNextStep(tower, status);
			if (status.error) throw new Error(status.error);
		}
	};
	const changes = (id: string, path?: string) => git.changes(tower.flight(id), tower.state.canonical.head, path);
	return { ws, tower, runTo, changes };
}

describe("Git-backed changes", () => {
	it("excludes rejected staging commits and unrelated canonical work after refresh", async () => {
		const { tower, runTo, changes } = await setup();
		await runTo("publish-021-rejected");
		expect(tower.flight("F-021").publishes.at(-1)?.approved).toBe(false);
		expect((await changes("F-021")).files).toEqual([]);
		await runTo("publish-021");
		const accepted = await changes("F-021");
		expect(accepted.files.some((file) => file.path.endsWith("refresh-token-repository.ts"))).toBe(true);
		expect(accepted.additions).toBeGreaterThan(0);
		expect(accepted.file).toBeUndefined();
		await runTo("refresh-021");
		const refreshed = await changes("F-021");
		expect(refreshed.baseCommit).toBe(tower.state.canonical.head);
		expect(refreshed.files.map((file) => file.path)).toEqual(accepted.files.map((file) => file.path));
		expect(refreshed.files.some((file) => file.path.includes("session") || file.path.includes("token-validator"))).toBe(false);
	});

	it("keeps a completed run pinned to its integration first parent as canonical advances", async () => {
		const { tower, runTo, changes, ws } = await setup();
		await runTo("land-022");
		const integrated = await changes("F-022");
		expect(integrated.comparison).toBe("integrated");
		expect(integrated.headCommit).toBe(tower.flight("F-022").landedCommit);
		expect(integrated.baseCommit).toBe((await ws.log(integrated.headCommit as string, 1))[0].parents[0]);
		await runTo("land-021");
		const later = await changes("F-022", "src/auth/token-validator.ts");
		expect(later.headCommit).toBe(integrated.headCommit);
		expect(later.baseCommit).toBe(integrated.baseCommit);
		expect(later.files).toEqual(integrated.files);
		expect(later.file?.patch).toContain("ValidationResult");
		expect(later.canonicalCommit).not.toBe(integrated.canonicalCommit);
	});

	it("reports added and deleted lines and safely omits binary and oversized content", async () => {
		const ws = new GitWorkspace(new MemoryFs() as never);
		await ws.ensureInit();
		const author = { name: "Test", email: "test@example.com", timestamp: 1 };
		const base = await ws.commit({
			ref: "refs/heads/main",
			parent: null,
			files: { "remove.ts": "one\ntwo\n", "edit.ts": "old\n" },
			message: "base",
			author,
		});
		const head = await ws.commit({
			ref: "refs/heads/review",
			parent: base,
			files: {
				"remove.ts": null,
				"edit.ts": "new\nextra\n",
				"added.ts": "hello\n",
				"binary.dat": "\0binary",
				"large.txt": "x".repeat(256001),
			},
			message: "changes",
			author,
		});
		const review = await ws.reviewChanges(base, head, "edit.ts");
		expect(review).toMatchObject({ additions: 3, deletions: 3, statsComplete: false });
		expect(review.file?.patch).toContain("-old\n+new\n+extra");
		expect(review.files.find((file) => file.path === "binary.dat")).toMatchObject({ binary: true, additions: null, deletions: null });
		expect((await ws.reviewChanges(base, head, "binary.dat")).file).toMatchObject({
			patch: null,
			reason: "Binary file; source diff unavailable.",
		});
		expect((await ws.reviewChanges(base, head, "large.txt")).file?.patch).toBeNull();
	});
});
