import { describe, expect, it } from "vitest";
import { initialRepository } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
import type { Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { topologyModel } from "../../src/ui/topology-model.ts";

const base = "a".repeat(40),
	head = "b".repeat(40);
const repository: Repository = {
	id: "repo",
	namespaceId: "ns",
	name: "test",
	defaultBranch: "main",
	createdAt: 0,
	storageName: "private-provider-name",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
	return {
		id,
		repositoryId: "repo",
		ownerId: "user",
		createdBy: { id: "actor", userId: "user", kind: "agent", name: "Agent" },
		title: id,
		baseRevision: base,
		headRevision: head,
		state: "active",
		startedAt: 0,
		lastActivity: 1,
		changes: [],
		commits: [],
		...overrides,
	};
}
function snapshot(workspaces: Workspace[] = []): RepositorySnapshot {
	return {
		...initialRepository(repository),
		workspaces,
		overlaps: [],
		workspaceUpdates: {},
		permissions: { write: true, maintain: true, human: true },
		sourceAvailable: false,
		readiness: {},
		forkCleanup: {},
		executionRelease: {},
		promotionRecovery: {},
	};
}
describe("coordination presentation", () => {
	it("keeps summaries minimal and preserves exact intersection membership", () => {
		const view = snapshot([
			workspace("a", {
				execution: {
					id: "local",
					checkoutId: "private",
					machineId: "private",
					kind: "worktree",
					owned: true,
					attachedBy: { id: "actor", userId: "user", kind: "agent", name: "Agent" },
					attachedAt: 1,
				},
			}),
			workspace("b"),
			workspace("detached", { state: "detached" }),
		]);
		view.overlaps = [{ id: "surface", kind: "file", surface: "private/path", workspaces: ["a", "b"], evidence: "reported", observedAt: 1 }];
		const summary = repositorySummary(view);
		expect(summary.active).toBe(2);
		expect(summary.topology).toEqual({
			workspaces: [
				{ id: "a", state: "active" },
				{ id: "b", state: "active" },
				{ id: "detached", state: "detached" },
			],
			intersections: [{ id: "surface", workspaces: ["a", "b"] }],
		});
		expect(JSON.stringify(summary)).not.toContain("private");
		summary.topology.intersections[0].workspaces.push("other");
		expect(view.overlaps[0].workspaces).toEqual(["a", "b"]);
	});
	it("uses canonical source only, never reported heads", () => {
		const view = snapshot([workspace("a")]);
		expect(topologyModel(view).canonical).toBeUndefined();
		view.sourceHead = base;
		expect(topologyModel(view).canonical).toBe(base);
	});
	it("limits stable workspace lanes and keeps disconnected and detached identity", () => {
		const view = snapshot([
			workspace("ended", { state: "completed" }),
			workspace("detached", { state: "detached", startedAt: 100 }),
			...Array.from({ length: 8 }, (_, i) => workspace(`writer-${i}`, { startedAt: i, state: i === 0 ? "disconnected" : "active" })),
		]);
		const model = topologyModel(view);
		expect(model.total).toBe(9);
		expect(model.lanes).toHaveLength(6);
		expect(model.lanes[0].workspace.state).toBe("disconnected");
		expect(topologyModel({ ...view, workspaces: [...view.workspaces].reverse() }).lanes.map((l) => l.workspace.id)).toEqual(
			model.lanes.map((l) => l.workspace.id),
		);
		expect(view.workspaces).toHaveLength(10);
	});
	it("does not convert approval or prepared promotion into canonical continuation", () => {
		const view = snapshot([workspace("a")]);
		view.proposals = [
			{
				id: "change",
				number: 1,
				workspaceId: "a",
				artifactId: "artifact",
				base,
				revision: head,
				title: "Change",
				state: "open",
				at: 1,
				reviews: [
					{
						id: "approval",
						actor: { id: "human", userId: "user", kind: "human", name: "Human" },
						revision: head,
						outcome: "approve",
						reason: "Reviewed",
						at: 2,
					},
				],
			},
		];
		view.promotions = [
			{ id: "promotion", proposalId: "change", from: base, to: head, actor: view.proposals[0].reviews[0].actor, at: 3, state: "prepared" },
		];
		expect(topologyModel(view).lanes[0].promotions).toEqual([]);
		view.promotions[0].state = "complete";
		expect(topologyModel(view).lanes[0].promotions).toHaveLength(1);
		view.promotions[0].to = "c".repeat(40);
		expect(topologyModel(view).lanes[0].promotions).toEqual([]);
	});
	it("retains independent overlap groups and handles empty observations", () => {
		const view = snapshot([workspace("a"), workspace("b"), workspace("c")]);
		view.overlaps = [
			{ id: "one", kind: "file", surface: "old/path → new/path", workspaces: ["a", "b"], evidence: "reported", observedAt: 1 },
			{ id: "two", kind: "file", surface: "asset.bin", workspaces: ["b", "c"], evidence: "reported", observedAt: 1 },
		];
		expect(topologyModel(view).intersections.map((o) => o.workspaces)).toEqual([
			["a", "b"],
			["b", "c"],
		]);
		expect(topologyModel(snapshot()).lanes).toEqual([]);
		expect(topologyModel(snapshot([workspace("one")])).total).toBe(1);
	});
});
