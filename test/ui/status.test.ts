import { describe, expect, it } from "vitest";
import { initialRepository } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
import type { Actor, Proposal, Readiness, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { actorLabel, ago, attention, canonicalRelation, changeGroups, changeStatus, overlapsFor, workedBy } from "../../src/ui/status.ts";

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
function view(extra: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
	return {
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
}

describe("console status language", () => {
	it("names the tool rather than the OAuth client plumbing", () => {
		expect(actorLabel(claude)).toBe("Claude Code");
		expect(actorLabel(codex)).toBe("Codex");
		expect(actorLabel({ name: "Alex Morgan", kind: "human" })).toBe("Alex Morgan");
		const continued = workspace("a", {
			execution: { id: "a", checkoutId: "c", machineId: "m", kind: "worktree", owned: true, attachedBy: codex, attachedAt: 0 },
		});
		expect(workedBy(continued)).toBe("Started in Claude Code · continued in Codex");
		expect(workedBy(workspace("b"))).toBe("Claude Code");
	});
	it("classifies changes by what a person should do", () => {
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
		expect(changeStatus(v, v.proposals[1])).toMatchObject({ key: "concerns" });
		expect(changeStatus(v, v.proposals[2])).toMatchObject({ key: "stale", detail: expect.stringContaining("bbbbbbbb") });
		// A later change from the same workspace supersedes; a promoted later change does too.
		expect(changeStatus(v, v.proposals[3])).toMatchObject({ key: "superseded", label: "Superseded by #5" });
		expect(changeStatus(v, v.proposals[4])).toMatchObject({ key: "promoted" });
		const groups = changeGroups(v);
		expect(groups.attention.map((p) => p.id)).toEqual(["newer"]);
		expect(groups.inactive.map((p) => p.id)).toEqual(["ready", "stale", "old"]);
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
		expect(attention(v)).toMatchObject({ review: 1, ready: 0, stale: 0, behind: 0, overlaps: 1 });
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
			readiness: { p: readiness(), q: readiness({}, true) },
		});
		const summary = repositorySummary(v);
		expect(summary.attention).toEqual({ review: 1, ready: 1, stale: 0, behind: 0 });
		// Superseded changes don't count as stale attention, even when canonical has moved past them.
		const superseded = view({
			sourceHead: moved,
			workspaces: [workspace("w1")],
			proposals: [proposal("old", 1, "w1"), proposal("new", 2, "w1", { state: "promoted" })],
			readiness: { old: readiness({ current: false, canonical: moved }) },
		});
		expect(repositorySummary(superseded).attention.stale).toBe(0);
		expect(JSON.stringify(summary)).not.toContain("storage");
	});
});
