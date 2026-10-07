import { describe, expect, it } from "vitest";
import { initialRepository } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
import type { Actor, Promotion, Proposal, Readiness, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { laneIndex, lanes, trunk } from "../../src/ui/lanes.ts";

const first = "a".repeat(40),
	second = "b".repeat(40),
	third = "c".repeat(40),
	unknown = "d".repeat(40);
const repository: Repository = {
	id: "repo",
	namespaceId: "ns",
	name: "test",
	defaultBranch: "main",
	createdAt: 0,
	storageName: "storage",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
};
const codex: Actor = { id: "x", userId: "u", kind: "agent", name: "Cruce codex bridge" };
const workspace = (id: string, startedAt: number, extra: Partial<Workspace> = {}): Workspace => ({
	id,
	repositoryId: "repo",
	ownerId: "u",
	createdBy: codex,
	title: id,
	baseRevision: first,
	headRevision: first,
	state: "active",
	startedAt,
	lastActivity: startedAt,
	changes: [],
	commits: [],
	...extra,
});
const proposal = (id: string, number: number, workspaceId: string, extra: Partial<Proposal> = {}): Proposal => ({
	id,
	number,
	workspaceId,
	artifactId: `${id}-artifact`,
	base: first,
	revision: second,
	title: id,
	state: "open",
	reviews: [],
	at: 0,
	...extra,
});
const promotion = (id: string, proposalId: string, from: string, to: string, at: number): Promotion => ({
	id,
	proposalId,
	from,
	to,
	actor: { id: "u", userId: "u", kind: "human", name: "Alex" },
	at,
	state: "complete",
});
const readiness = (checks: Partial<Readiness["checks"]> = {}, ready = false): Readiness => ({
	ready,
	reasons: [],
	checks: { open: true, current: true, approved: false, reviewIds: [], concerns: 0, evidence: [], blockedByPromotion: false, ...checks },
});
function view(extra: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
	return {
		...initialRepository(repository),
		overlaps: [],
		workspaceUpdates: {},
		permissions: { write: true, maintain: true, human: true, approve: true },
		sourceAvailable: true,
		readiness: {},
		promotionRecovery: {},
		forkCleanup: {},
		executionRelease: {},
		...extra,
	} as RepositorySnapshot;
}

describe("lane map model", () => {
	const promoted = view({
		sourceHead: third,
		workspaces: [
			workspace("done", 0, { state: "completed" }),
			workspace("early", 1),
			workspace("late", 2, { baseRevision: second, publishedRevision: third }),
			workspace("orphan", 3, { baseRevision: unknown, state: "disconnected" }),
		],
		proposals: [
			proposal("p1", 1, "done", { state: "promoted" }),
			proposal("p2", 2, "done", { state: "promoted", base: second, revision: third }),
		],
		promotions: [promotion("one", "p1", first, second, 10), promotion("two", "p2", second, third, 20)],
	});
	it("draws canonical as recorded promotions in order, ending at the accepted head", () => {
		expect(trunk(promoted).map((n) => n.revision)).toEqual([first, second, third]);
		expect(trunk(promoted)[1]).toMatchObject({ change: 1, lane: 1 });
	});
	it("keeps a stable colour per workspace by start order, including ended work", () => {
		const colours = laneIndex(promoted);
		expect([...colours.values()]).toEqual([1, 2, 3, 4]);
		expect(lanes(promoted).map((l) => [l.id, l.lane])).toEqual([
			["early", 2],
			["late", 3],
			["orphan", 4],
		]);
	});
	it("places baselines only on recorded canonical revisions and never guesses the rest", () => {
		const [early, late, orphan] = lanes(promoted);
		expect(early.baseline).toBe(0);
		expect(late.baseline).toBe(1);
		expect(late.published).toBe(third);
		expect(orphan.baseline).toBeUndefined();
		expect(orphan.quiet).toBe(true);
	});
	it("excludes ended workspaces from the map", () => {
		expect(lanes(promoted).some((l) => l.id === "done")).toBe(false);
	});
});

describe("repository summary for Home", () => {
	it("names the open changes behind the counts and the live lanes, newest first", () => {
		const summary = repositorySummary(
			view({
				sourceHead: first,
				workspaces: [workspace("w1", 1), workspace("w2", 2, { state: "disconnected" }), workspace("w3", 3, { state: "completed" })],
				proposals: [proposal("p", 1, "w1"), proposal("q", 2, "w2")],
				readiness: { p: readiness(), q: readiness({}, true) },
			}),
		);
		expect(summary.changes.map((c) => [c.number, c.status])).toEqual([
			[2, "ready"],
			[1, "review"],
		]);
		expect(summary.lanes).toEqual([
			{ relation: "unknown", quiet: false },
			{ relation: "unknown", quiet: true },
		]);
	});
});
