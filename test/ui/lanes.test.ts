import { describe, expect, it } from "vitest";
import { initialRepository } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
import type { Actor, Promotion, Proposal, Readiness, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { laneHistory, laneIndex, lanes, repositoryAxis, timeAxis, trunk } from "../../src/ui/lanes.ts";

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
	checks: {
		open: true,
		current: true,
		approved: false,
		reviewIds: [],
		concerns: 0,
		answered: 0,
		evidence: [],
		blockedByPromotion: false,
		...checks,
	},
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
		executionRelease: {},
		workspaceDeletion: {},
		...extra,
	} as RepositorySnapshot;
}

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

describe("lane map model", () => {
	it("draws canonical as recorded promotions in order, ending at the accepted head", () => {
		expect(trunk(promoted).map((n) => n.revision)).toEqual([first, second, third]);
		expect(trunk(promoted)[1]).toMatchObject({ change: 1, lane: 1, title: expect.any(String) });
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
	it("separates detached work and never implies connection without an active attachment", () => {
		const [detached, quiet, missing, connected] = lanes(
			view({
				workspaces: [
					workspace("detached", 1, { state: "detached", publishedRevision: second }),
					workspace("quiet", 2, { state: "disconnected" }),
					workspace("missing", 3),
					workspace("connected", 4, {
						execution: {
							id: "exec",
							checkoutId: "checkout",
							machineId: "machine",
							kind: "worktree",
							owned: true,
							attachedBy: codex,
							attachedAt: 0,
						},
					}),
				],
			}),
		);
		expect(detached).toMatchObject({ detached: true, quiet: true, presence: "detached", published: second });
		expect(quiet).toMatchObject({ detached: false, quiet: true, presence: "quiet" });
		expect(missing.quiet).toBe(true);
		expect(connected).toMatchObject({ quiet: false, presence: "connected" });
	});
	it("excludes ended workspaces from the map", () => {
		expect(lanes(promoted).some((l) => l.id === "done")).toBe(false);
	});
	it("times trunk revisions by their recorded promotion and leaves earlier ones untimed", () => {
		expect(trunk(promoted).map((n) => n.promotion?.at)).toEqual([undefined, 10, 20]);
	});
});

describe("lane history and time axis", () => {
	const minute = 60_000;
	it("collects reported heads, publications, the latest change and its promotion at their earliest sighting", () => {
		const w = workspace("w", 0, { headRevision: third, lastReportAt: 9 * minute, lastActivity: 12 * minute });
		const history = laneHistory(
			view({
				workspaces: [w],
				activity: [
					{ id: "event-1", actor: codex, kind: "changes_reported", summary: "", ids: ["w", second], at: 2 * minute },
					{ id: "event-2", actor: codex, kind: "changes_reported", summary: "", ids: ["other", unknown], at: 3 * minute },
					{ id: "event-3", actor: codex, kind: "changes_reported", summary: "", ids: ["w", first], at: 4 * minute },
				],
				artifacts: [
					{ id: "a", workspaceId: "w", revision: second, kind: "source", at: 5 * minute } as never,
					{ id: "e", workspaceId: "w", revision: unknown, kind: "evidence", at: 6 * minute } as never,
				],
				proposals: [
					proposal("p", 1, "w", {
						revision: second,
						at: 6 * minute,
						reviews: [
							{ id: "r", actor: codex, revision: second, outcome: "approve", reason: "", at: 7 * minute },
							{ id: "s", actor: codex, revision: first, outcome: "approve", reason: "", at: 1 * minute },
						],
					}),
				],
				promotions: [promotion("x", "p", first, second, 8 * minute)],
			}),
			w,
		);
		// The baseline is never a lane revision; the head without a report event takes its report time.
		expect(history.revisions).toEqual([
			{ revision: second, at: 2 * minute },
			{ revision: third, at: 9 * minute },
		]);
		expect(history.publications).toEqual([{ revision: second, at: 5 * minute }]);
		expect(history.change).toEqual({
			number: 1,
			revision: second,
			at: 6 * minute,
			approvedAt: 7 * minute,
			promotion: { id: "x", to: second, at: 8 * minute },
		});
		expect(history.lastSeen).toBe(12 * minute);
	});
	it("keeps simultaneous records apart, compresses idle time and marks long gaps", () => {
		const axis = timeAxis(
			[{ key: "origin" }, { key: "a", at: 0 }, { key: "b", at: 0 }, { key: "c", at: minute }, { key: "d", at: 3 * 86_400_000 }],
			3 * 86_400_000 + minute,
		);
		const [origin, a, b, c, d] = ["origin", "a", "b", "c", "d"].map((key) => axis.slot(key) ?? Number.NaN);
		expect(origin).toBe(0);
		expect(a).toBeLessThan(b);
		expect(b).toBeLessThan(c);
		expect(c).toBeLessThan(d);
		expect(d).toBeLessThan(1);
		// A three-day gap takes more room than a minute, but far less than linear time would.
		expect(d - c).toBeGreaterThan(c - b);
		expect(d - c).toBeLessThan(0.7);
		expect(axis.breaks).toHaveLength(1);
		expect(axis.breaks[0].gap).toBe(3 * 86_400_000 - minute);
		expect(axis.at(0)).toBe(a);
		expect(axis.at(3 * 86_400_000 + minute)).toBe(1);
		expect(axis.time(c)).toBe(minute);
		expect(axis.time(1)).toBe(3 * 86_400_000 + minute);
		expect(axis.ticks.map((t) => t.at)).toEqual([0, minute, 3 * 86_400_000]);
	});
	it("places every live lane and recorded promotion on one repository axis", () => {
		const axis = repositoryAxis(
			promoted,
			lanes(promoted).map((lane) => laneHistory(promoted, promoted.workspaces.find((w) => w.id === lane.id) as Workspace)),
			30,
		);
		expect(axis.slot(`main:${first}`)).toBe(0);
		expect(axis.slot(`main:${second}`)).toBeLessThan(axis.slot(`main:${third}`) ?? 0);
		expect(axis.slot("start:early")).toBeDefined();
		expect(axis.slot(`rev:late:${first}`)).toBeDefined();
		expect(axis.slot(`rev:late:${third}`)).toBeDefined();
	});
});

describe("repository summary for Home", () => {
	it("names the attention items behind the counts in group order, and the live lanes", () => {
		const summary = repositorySummary(
			view({
				sourceHead: first,
				workspaces: [workspace("w1", 1), workspace("w2", 2, { state: "disconnected" }), workspace("w3", 3, { state: "completed" })],
				proposals: [proposal("p", 1, "w1"), proposal("q", 2, "w2")],
				readiness: { p: readiness(), q: readiness({ approved: true }, true) },
			}),
		);
		expect(summary.items.map((item) => [item.number, item.group])).toEqual([
			[2, "promote"],
			[1, "review"],
		]);
		expect(summary.lanes).toEqual([
			{ relation: "unknown", quiet: false },
			{ relation: "unknown", quiet: true },
		]);
	});
});
