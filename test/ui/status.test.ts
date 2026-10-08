import { describe, expect, it } from "vitest";
import { attentionView } from "../../src/core/attention.ts";
import { initialRepository } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
import type { Actor, Proposal, Readiness, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import {
	actorLabel,
	ago,
	attention,
	blockerSummary,
	canonicalRelation,
	changeGroups,
	changeStatus,
	nextStep,
	overlapGroups,
	overlapsFor,
	ownerName,
	settledInMain,
	throughConnection,
	unproposed,
	waitingOn,
	workedBy,
} from "../../src/ui/status.ts";

const base = "a".repeat(40),
	moved = "b".repeat(40);
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
const claude: Actor = { id: "c", userId: "u", kind: "agent", name: "Cruce claude bridge" };
const codex: Actor = { id: "x", userId: "u", kind: "agent", name: "Cruce codex bridge" };
const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
	id,
	repositoryId: "repo",
	ownerId: "u",
	createdBy: claude,
	title: id,
	baseRevision: base,
	headRevision: base,
	state: "active",
	startedAt: 0,
	lastActivity: 0,
	changes: [],
	commits: [],
	...extra,
});
const proposal = (id: string, number: number, workspaceId: string, extra: Partial<Proposal> = {}): Proposal => ({
	id,
	number,
	workspaceId,
	artifactId: `${id}-artifact`,
	base,
	revision: "c".repeat(40),
	title: id,
	state: "open",
	reviews: [],
	at: 0,
	...extra,
});
const readiness = (checks: Partial<Readiness["checks"]> = {}, ready = false): Readiness => ({
	ready,
	reasons: [],
	checks: { open: true, current: true, approved: false, reviewIds: [], concerns: 0, evidence: [], blockedByPromotion: false, ...checks },
});
function view(extra: Partial<RepositorySnapshot> = {}, viewerId = "u"): RepositorySnapshot {
	const snapshot: RepositorySnapshot = {
		...initialRepository(repository),
		overlaps: [],
		workspaceUpdates: {},
		permissions: { write: true, maintain: true, human: true, approve: true },
		sourceAvailable: true,
		readiness: {},
		forkCleanup: {},
		executionRelease: {},
		canonicalSetup: { required: false, retry: false },
		promotionRecovery: {},
		...extra,
	};
	return { ...snapshot, attention: attentionView(snapshot, viewerId) };
}

describe("console status language", () => {
	it("names the tool rather than the OAuth client plumbing", () => {
		expect(actorLabel(claude)).toBe("Claude Code");
		expect(actorLabel(codex)).toBe("Codex");
		expect(actorLabel({ name: "Alex Morgan", kind: "human" })).toBe("Alex Morgan");
		const continued = workspace("a", {
			execution: { id: "a", checkoutId: "c", machineId: "m", kind: "worktree", owned: true, attachedBy: codex, attachedAt: 0 },
		});
		expect(workedBy(continued)).toBe("Started through Claude Code · attached through Codex");
		expect(workedBy(workspace("b"))).toBe("Started through Claude Code");
	});
	it("classifies changes by the next action", () => {
		const v = view({
			sourceHead: base,
			workspaces: [workspace("w1"), workspace("w2"), workspace("w3")],
			proposals: [
				proposal("old", 1, "w1"),
				proposal("newer", 3, "w1"),
				proposal("stale", 2, "w2"),
				proposal("ready", 4, "w3"),
				proposal("done", 5, "w3", { state: "promoted" }),
			],
			readiness: {
				old: readiness(),
				newer: readiness({ concerns: 1 }),
				stale: readiness({ current: false, canonical: moved }),
				ready: readiness({ approved: true }, true),
			},
		});
		expect(changeStatus(v, v.proposals[0])).toMatchObject({ key: "superseded", label: "Superseded by #3" });
		expect(changeStatus(v, v.proposals[1])).toMatchObject({ key: "review", label: "Needs human review" });
		expect(changeStatus(v, v.proposals[2])).toMatchObject({
			key: "reconciliation",
			label: "Needs Git update",
			detail: expect.stringContaining("bbbbbbbb"),
		});
		const stale = v.attention!.items.find((item) => item.id === "stale")!;
		expect(nextStep(stale)).toContain("verify, push, publish and propose the new revision");
		expect(waitingOn(stale)).toBe("Waiting on the owner or their authorized agent");
		expect(nextStep({ ...stale, blockers: [{ kind: "canonical_relation", relation: "unrelated", canonical: moved }] })).toBe(
			"Inspect the unrelated Git histories in the workspace before choosing how to reconcile them",
		);
		// A later change from the same workspace supersedes; a promoted later change does too.
		expect(changeStatus(v, v.proposals[3])).toMatchObject({ key: "superseded", label: "Superseded by #5" });
		expect(changeStatus(v, v.proposals[4])).toMatchObject({ key: "promoted" });
		const groups = changeGroups(v);
		expect(Object.fromEntries(groups.attention.map(({ group, items }) => [group, items.map((item) => item.id)]))).toEqual({
			recovery: [],
			promote: [],
			review: ["newer"],
			preparation: [],
			reconciliation: ["stale"],
		});
		expect(groups.inactive.map((p) => p.id)).toEqual(["ready", "old"]);
		expect(groups.done.map((p) => p.id)).toEqual(["done"]);
	});
	it("summarizes attention, canonical relation and advisory overlaps", () => {
		const v = view({
			sourceHead: moved,
			workspaces: [workspace("Retry"), workspace("Timeouts"), workspace("Done", { state: "completed" })],
			workspaceUpdates: {
				Retry: { baselineRevision: base, revision: moved, status: "available", trust: "accepted" },
				Timeouts: { baselineRevision: moved, revision: moved, status: "current", trust: "accepted" },
				Done: { baselineRevision: base, revision: moved, status: "available", trust: "accepted" },
			},
			overlaps: [{ id: "f", kind: "file", surface: "README.md", workspaces: ["Retry", "Timeouts"], evidence: "reported", observedAt: 0 }],
			proposals: [proposal("p", 1, "Retry")],
			readiness: { p: readiness() },
		});
		expect(canonicalRelation(v, v.workspaces[0])).toMatchObject({ key: "unknown", label: "Canonical moved" });
		expect(canonicalRelation(v, v.workspaces[1])).toMatchObject({ key: "current" });
		expect(overlapsFor(v, v.workspaces[0])).toEqual([{ path: "README.md", others: ["Timeouts"], observedAt: 0 }]);
		expect(attention(v)).toMatchObject({ review: 1, promote: 0, reconcileChanges: 0, reconcileWorkspaces: 0, overlaps: 1 });
	});
	it("flags published work that no change proposes and groups shared paths once", () => {
		const published = "c".repeat(40);
		const source = (workspaceId: string, revision: string) =>
			({
				id: `a-${workspaceId}`,
				workspaceId,
				revision,
				kind: "source",
				title: workspaceId,
				at: 1,
			}) as unknown as RepositorySnapshot["artifacts"][number];
		const ahead = (workspaceId: string) => ({
			workspaceId,
			revision: published,
			basis: "published" as const,
			canonicalRevision: base,
			relation: "ahead" as const,
			report: { state: "fresh" } as never,
			incorporationCounts: { present: 0, missing: 0, unknown: 0 },
			incorporationTruncated: false,
			incorporation: [],
		});
		const v = view({
			sourceHead: base,
			workspaces: [
				workspace("a", { publishedRevision: published }),
				workspace("b", { publishedRevision: published }),
				workspace("c"),
				workspace("done", { publishedRevision: published, state: "completed" }),
			],
			artifacts: [source("a", published), source("b", published), source("done", published)],
			proposals: [proposal("p", 1, "b", { revision: published })],
			reconciliation: {
				asOf: 0,
				observation: { state: "current" } as never,
				workspaces: [ahead("a"), ahead("b"), ahead("done")],
				proposals: [],
			},
			overlaps: ["pom.xml", ".gitignore"].map((surface) => ({
				id: `file:${surface}`,
				kind: "file" as const,
				surface,
				workspaces: ["a", "b", "c"],
				evidence: "reported" as const,
				observedAt: 0,
			})),
		});
		expect(unproposed(v, v.workspaces[0])?.id).toBe("a-a");
		expect(unproposed(v, v.workspaces[1])).toBeUndefined();
		expect(unproposed(v, v.workspaces[2])).toBeUndefined();
		expect(unproposed(v, v.workspaces[3])).toBeUndefined();
		expect(attention(v).unproposed).toBe(1);
		expect(overlapGroups(v)).toEqual([{ workspaces: ["a", "b", "c"], paths: ["pom.xml", ".gitignore"] }]);
	});
	it("folds only work that is already in canonical and says why", () => {
		const published = "c".repeat(40);
		const row = (workspaceId: string, relation: "current" | "behind" | "ahead", basis: "published" | "baseline" = "published") => ({
			workspaceId,
			revision: published,
			basis,
			canonicalRevision: base,
			relation,
			report: { state: "fresh" } as never,
			incorporationCounts: { present: 0, missing: 0, unknown: 0 },
			incorporationTruncated: false,
			incorporation: [],
		});
		const done = (id: string, extra: Partial<Workspace> = {}) =>
			workspace(id, { publishedRevision: published, headRevision: published, ...extra });
		const v = view({
			sourceHead: base,
			workspaces: [
				done("own"),
				done("other"),
				done("open"),
				done("newer", { headRevision: "d".repeat(40) }),
				done("baseline"),
				done("detached", { state: "detached" }),
			],
			proposals: [
				proposal("p-own", 1, "own", { state: "promoted", revision: published }),
				proposal("p-open", 2, "open", { revision: published }),
			],
			reconciliation: {
				asOf: 0,
				observation: { state: "current" } as never,
				workspaces: [
					row("own", "current"),
					row("other", "behind"),
					row("open", "behind"),
					row("newer", "behind"),
					row("baseline", "behind", "baseline"),
					row("detached", "behind"),
				],
				proposals: [],
			},
		});
		const by = (id: string) => v.workspaces.find((w) => w.id === id)!;
		expect(settledInMain(v, by("own"))).toBe("own");
		expect(settledInMain(v, by("other"))).toBe("other");
		expect(canonicalRelation(v, by("other"))).toMatchObject({ key: "contained", label: "Already in canonical", tone: "success" });
		expect(settledInMain(v, by("open"))).toBeUndefined();
		expect(settledInMain(v, by("newer"))).toBeUndefined();
		expect(settledInMain(v, by("baseline"))).toBeUndefined();
		expect(settledInMain(v, by("detached"))).toBeUndefined();
	});
	it("says plainly when canonical has not been compared yet", () => {
		const v = view({ workspaces: [workspace("w")] });
		expect(canonicalRelation(v, v.workspaces[0])).toMatchObject({ key: "unknown", label: "Not compared yet" });
	});
	it("describes elapsed time plainly", () => {
		expect(ago(1000, 2000)).toBe("just now");
		expect(ago(0, 5 * 60_000)).toBe("5 min ago");
		expect(ago(0, 3 * 3_600_000)).toBe("3 h ago");
	});
	it("keeps namespace summaries to counts without leaking storage names", () => {
		const v = view({
			sourceHead: base,
			workspaces: [workspace("w1"), workspace("w2")],
			workspaceUpdates: { w1: { baselineRevision: base, revision: moved, status: "available", trust: "accepted" } },
			proposals: [proposal("p", 1, "w1"), proposal("q", 2, "w2")],
			readiness: { p: readiness(), q: readiness({ approved: true }, true) },
		});
		const summary = repositorySummary(v);
		expect(summary.attention).toEqual({
			recovery: 0,
			promote: 1,
			review: 1,
			preparation: 0,
			reconciliation: 0,
			mine: 2,
			total: 2,
			ancestryUnavailable: 0,
		});
		// Superseded changes don't count as stale attention, even when canonical has moved past them.
		const superseded = view({
			sourceHead: moved,
			workspaces: [workspace("w1")],
			proposals: [proposal("old", 1, "w1"), proposal("new", 2, "w1", { state: "promoted" })],
			readiness: { old: readiness({ current: false, canonical: moved }) },
		});
		expect(repositorySummary(superseded).attention.reconciliation).toBe(0);
		expect(JSON.stringify(summary)).not.toContain("storage");
	});
	it("words structured blockers, next steps and ownership without parsing prose", () => {
		const v = view({
			sourceHead: base,
			workspaces: [workspace("w1"), workspace("w2", { ownerId: "maya" })],
			proposals: [proposal("p", 1, "w1"), proposal("q", 2, "w2")],
			readiness: {
				p: readiness({ evidence: [{ kind: "tests", trusted: false, reported: true, failed: false, verificationIds: [] }] }),
				q: readiness({ evidence: [{ kind: "tests", trusted: false, reported: false, failed: false, verificationIds: [] }] }),
			},
		});
		const [p, q] = ["p", "q"].map((id) => v.attention!.items.find((item) => item.id === id)!);
		expect(blockerSummary(p)).toBe("Tests reported passing; human attestation required · 1 more blocker");
		expect(nextStep(p)).toBe("Inspect the reported evidence and attest what you checked");
		// Missing evidence is the owner's preparation, never something a maintainer simply confirms.
		expect(blockerSummary(q)).toBe("Required tests evidence missing · 1 more blocker");
		expect(q.mine).toBe(false);
		expect(waitingOn(q)).toBe("Waiting on the owner");
		const who = { viewerId: "u", people: [{ id: "u", name: "Alex Morgan" }] };
		expect(ownerName("u", who)).toBe("Alex Morgan (you)");
		expect(ownerName("maya", who)).toBe("Owner name unavailable");
		expect(throughConnection(codex, who)).toBe("through Codex, your connection");
		expect(throughConnection({ ...codex, userId: "maya" }, { people: [{ id: "maya", name: "Maya" }] })).toBe(
			"through Codex, Maya's connection",
		);
	});
});
