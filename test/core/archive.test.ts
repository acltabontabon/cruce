import { describe, expect, it } from "vitest";
import { archiveLayout, finishedWork, withoutBundles } from "../../src/core/archive.ts";
import { initialRepository } from "../../src/core/platform.ts";
import { STATE_LIMITS } from "../../src/shared/limits.ts";
import type { Actor, Promotion, Proposal, Repository, RepositoryState, Workspace } from "../../src/shared/platform.ts";

const human: Actor = { id: "owner", userId: "owner", name: "Owner", kind: "human" };
const repository: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "source",
	storageName: "repo-source",
	defaultBranch: "main",
	createdAt: 0,
	grants: [],
	policy: { requiredEvidence: [], protectedPaths: [], resourceRules: {} },
};
const rev = (n: number) => n.toString(16).padStart(40, "0");
function work(state: RepositoryState, id: string, overrides: Partial<Workspace> = {}, change?: Proposal["state"]) {
	state.workspaces.push({
		id,
		repositoryId: "repo",
		ownerId: "owner",
		createdBy: human,
		title: id,
		baseRevision: rev(0),
		headRevision: rev(1),
		state: "completed",
		startedAt: 0,
		lastActivity: 0,
		changes: [],
		commits: [],
		fork: { name: `fork-${id}`, id: `fork-${id}`, remote: "https://example.invalid", state: "deleted" },
		cleanup: { operationId: "op", actorId: "owner", state: "complete", phase: "confirmed", attempts: 1 },
		...overrides,
	});
	state.artifacts.push({
		id: `${id}-source`,
		namespaceId: "namespace",
		repositoryId: "repo",
		workspaceId: id,
		actor: human,
		revision: rev(1),
		kind: "source",
		title: id,
		contentHash: "hash",
		trust: "reported",
		storage: { repository: "artifacts", providerId: "artifacts-id", revision: rev(1), ref: `refs/heads/artifact-${id}` },
		at: 0,
	});
	if (change)
		state.proposals.push({
			id: `${id}-change`,
			number: ++state.proposalCount,
			workspaceId: id,
			artifactId: `${id}-source`,
			base: rev(0),
			revision: rev(1),
			title: id,
			state: change,
			reviews: [],
			at: 0,
		});
}
const promotion = (id: string, proposalId: string, overrides: Partial<Promotion> = {}): Promotion => ({
	id,
	proposalId,
	from: rev(0),
	to: rev(1),
	actor: human,
	at: 0,
	state: "complete",
	...overrides,
});
const ids = (state: RepositoryState) => finishedWork(state, 5).map((b) => b.workspace.id);

describe("finished work archival", () => {
	it("selects only ended work with no live fork, open change or unsettled promotion", () => {
		const state = initialRepository(repository);
		work(state, "done", {}, "rejected");
		work(state, "no-fork", { fork: undefined, cleanup: undefined, state: "cancelled" });
		work(state, "active", { state: "active" });
		work(state, "retained", { fork: { name: "f", id: "f", remote: "r", state: "ready" } });
		work(state, "deleting", { fork: { name: "f", id: "f", remote: "r", state: "deleting" } });
		work(state, "blocked", { cleanup: { operationId: "op", actorId: "owner", state: "blocked", phase: "authorized", attempts: 1 } });
		work(state, "open", {}, "open");
		work(state, "promoting", {}, "promoting");
		work(state, "unsettled", {}, "promoted");
		state.promotions.push(
			promotion("unsettled-p", "unsettled-change", {
				operation: { id: "op", fingerprint: "f", reservationId: "r", phase: "confirmed", command: {} as never },
			}),
		);
		expect(ids(state)).toEqual(["done", "no-fork"]);
	});

	it("keeps the newest accepted promotions hot so reconciliation always sees the chain's tip", () => {
		const state = initialRepository(repository);
		for (let n = 0; n < STATE_LIMITS.recentPromotions + 2; n++) {
			work(state, `w${n}`, {}, "promoted");
			state.promotions.push(promotion(`p${n}`, `w${n}-change`));
		}
		expect(ids(state)).toEqual(["w0", "w1"]);
		state.promotions.push(promotion("failed", "w0-change", { state: "failed" }));
		expect(ids(state)).toEqual(["w0", "w1"]);
	});

	it("keeps evidence another change still names, and leaves hot state referentially closed", () => {
		const state = initialRepository(repository);
		work(state, "evidence", {}, "rejected");
		work(state, "live", { state: "active", fork: undefined, cleanup: undefined }, "open");
		state.verifications.push({
			id: "v",
			proposalId: "live-change",
			revision: rev(1),
			kind: "tests",
			outcome: "pass",
			trust: "reported",
			actor: human,
			summary: "pass",
			artifactId: "evidence-source",
			at: 0,
		});
		expect(ids(state)).toEqual([]);
		state.verifications = [];
		const bundles = finishedWork(state, 5);
		const hot = withoutBundles(state, bundles);
		expect(hot.archiveCount).toBe(1);
		const workspaceIds = new Set(hot.workspaces.map((w) => w.id));
		const artifactIds = new Set(hot.artifacts.map((a) => a.id));
		const proposalIds = new Set(hot.proposals.map((p) => p.id));
		expect(hot.proposals.every((p) => workspaceIds.has(p.workspaceId) && artifactIds.has(p.artifactId))).toBe(true);
		expect(hot.artifacts.every((a) => workspaceIds.has(a.workspaceId))).toBe(true);
		expect(hot.promotions.every((p) => proposalIds.has(p.proposalId))).toBe(true);
		expect(state.workspaces).toHaveLength(2);
	});

	it("counts changes from recorded state before archival existed", () => {
		const state = initialRepository(repository) as Partial<RepositoryState> & RepositoryState;
		work(state, "a", {}, "rejected");
		work(state, "b", {}, "rejected");
		delete (state as Partial<RepositoryState>).proposalCount;
		delete (state as Partial<RepositoryState>).archiveCount;
		expect(archiveLayout(state)).toMatchObject({ proposalCount: 2, archiveCount: 0 });
	});
});
