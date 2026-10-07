import { describe, expect, it } from "vitest";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import { reportFreshness } from "../../src/core/reconciliation.ts";
import type { ObservationStatus, Promotion, Workspace } from "../../src/shared/platform.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { readReconciliation } from "../../src/worker/reconciliation.ts";

async function fixture() {
	const fs = new MemoryFs(),
		git = new GitWorkspace(fs as never);
	await git.ensureInit();
	const author = { name: "fixture", email: "fixture@example.test", timestamp: 1 };
	const commit = (ref: string, parent: string | null, extraParents: string[] = []) =>
		git.commit({ ref, parent, extraParents, files: { [ref.split("/").at(-1)!]: "text" }, message: ref, author });
	const base = await commit("refs/heads/base", null);
	const accepted = await commit("refs/heads/canonical", base);
	const independent = await commit("refs/heads/work", base);
	const merged = await commit("refs/heads/merge", independent, [accepted]);
	const unrelated = await commit("refs/heads/unrelated", null);
	const state = initialRepository({
		id: "r",
		namespaceId: "n",
		name: "r",
		defaultBranch: "main",
		createdAt: 1,
		storageName: "canonical",
		grants: [],
		policy: { requiredEvidence: [], protectedPaths: [], resourceRules: {} },
	});
	state.sourceHead = accepted;
	state.promotions.push({
		id: "promotion",
		proposalId: "p",
		from: base,
		to: accepted,
		state: "complete",
		at: 1,
		actor: { id: "u", userId: "u", name: "User", kind: "human" },
	} as Promotion);
	const workspace = (id: string, publishedRevision?: string, baseRevision = base): Workspace => ({
		id,
		repositoryId: "r",
		ownerId: "u",
		createdBy: { id: "a", userId: "u", name: "agent", kind: "agent" },
		title: id,
		baseRevision,
		headRevision: accepted,
		publishedRevision,
		state: "active",
		startedAt: 1,
		lastActivity: 90000,
		lastReportAt: 1,
		changes: [],
		commits: [],
	});
	state.workspaces.push(
		workspace("behind", base),
		workspace("ahead", merged),
		workspace("diverged", independent),
		workspace("unrelated", unrelated),
		workspace("current", accepted),
		workspace("unpublished"),
		workspace("missing", "f".repeat(40)),
	);
	const observation: ObservationStatus = {
		enabled: false,
		state: "disabled",
		generation: 0,
		pending: 0,
		workspaces: {},
		estimatedDailyOperations: 96,
	};
	return {
		git,
		fs,
		state,
		observation,
		base,
		accepted,
		merged,
		read: () => readReconciliation(new RepositoryController(state, 90001, () => "id"), observation, git),
	};
}
describe("published reconciliation", () => {
	it("uses complete merge ancestry including second parents, never the reported checkout head", async () => {
		const f = await fixture();
		const r = await f.read();
		expect(r.workspaces.map((w) => [w.workspaceId, w.relation])).toEqual([
			["behind", "behind"],
			["ahead", "ahead"],
			["diverged", "diverged"],
			["unrelated", "unrelated"],
			["current", "current"],
			["unpublished", "behind"],
			["missing", "unknown"],
		]);
		expect(r.workspaces.find((w) => w.workspaceId === "ahead")!.incorporation[0].state).toBe("present");
		expect(r.workspaces.find((w) => w.workspaceId === "behind")!.incorporation[0].state).toBe("missing");
		expect(r.workspaces.find((w) => w.workspaceId === "unpublished")).toMatchObject({
			basis: "baseline",
			incorporation: [{ state: "unknown" }],
		});
		expect(r.workspaces.every((w) => w.report.state === "stale")).toBe(true);
	});
	it("returns unknown after cache loss without writing or fetching, and reports stale proposals from observed canonical", async () => {
		const f = await fixture();
		f.observation.canonical = {
			providerId: "canonical",
			ref: "refs/heads/main",
			revision: f.merged,
			deleted: false,
			checkedAt: 10,
			generation: 1,
		};
		f.state.observedCanonical = f.observation.canonical;
		f.state.proposals.push({
			id: "p",
			number: 1,
			workspaceId: "behind",
			artifactId: "artifact",
			base: f.accepted,
			revision: f.merged,
			title: "change",
			state: "open",
			reviews: [],
			at: 1,
		});
		const r = await f.read();
		expect(r.proposals[0].stale).toBe(true);
		expect(r.proposals[0].readiness.ready).toBe(false);
		const empty = new GitWorkspace(new MemoryFs() as never);
		const after = await readReconciliation(new RepositoryController(f.state, 90001, () => "id"), f.observation, empty);
		expect(after.workspaces.every((w) => w.relation === "unknown")).toBe(true);
		expect(after.workspaces.every((w) => w.incorporation[0].state === "unknown")).toBe(true);
	});
	it("bounds all-parent traversal and does not count presence as report freshness", async () => {
		const f = await fixture();
		await expect(f.git.ancestors(f.merged, new Map(), { remaining: 1, bytes: 1024 * 1024 })).rejects.toThrow("traversal limit");
		expect(reportFreshness(undefined, 100000)).toEqual({ state: "unknown" });
		expect(reportFreshness(1, 90000).state).toBe("fresh");
		expect(reportFreshness(1, 90001).state).toBe("stale");
	});
});
