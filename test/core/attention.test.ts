import { describe, expect, it } from "vitest";
import { attentionView } from "../../src/core/attention.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Authority, Command, ReconciliationView, Repository, RepositoryRole } from "../../src/shared/platform.ts";

const maya: Actor = { id: "maya", userId: "maya", name: "Maya", kind: "human" };
const luis: Actor = { id: "luis", userId: "luis", name: "Luis", kind: "human" };
const mayaAgent: Actor = { id: "maya-codex", userId: "maya", name: "Codex", kind: "agent", connectionId: "oauth-maya" };
const luisAgent: Actor = { id: "luis-claude", userId: "luis", name: "Claude Code", kind: "agent", connectionId: "oauth-luis" };
const repo: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "payments",
	defaultBranch: "main",
	createdAt: 0,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
};
const c0 = "0".repeat(40),
	c1 = "1".repeat(40),
	r1 = "a".repeat(40),
	r2 = "b".repeat(40),
	r3 = "c".repeat(40);
const authority = (actor: Actor, repositoryRole: RepositoryRole = "maintain"): Authority => ({
	actor,
	namespaceId: "namespace",
	repositoryId: "repo",
	role: repositoryRole === "maintain" ? "maintainer" : repositoryRole === "write" ? "developer" : "viewer",
	repositoryRole,
});

function setup() {
	let id = 0;
	const c = new RepositoryController(initialRepository(repo), 1_000, () => `id-${++id}`);
	c.state.sourceHead = c0;
	const run = (actor: Actor, cmd: Partial<Command> & { tool: string }) =>
		c.command({ namespaceId: "namespace", repositoryId: "repo", ...cmd }, authority(actor));
	/** A workspace owned by the agent's user, published and proposed at `revision` against `base`. */
	const propose = (agent: Actor, title: string, revision: string, base = c0) => {
		const w = run(agent, { tool: "start_workspace", title, baseRevision: base }) as { id: string };
		const artifactId = `artifact-${w.id}`;
		c.addArtifact({
			id: artifactId,
			namespaceId: "namespace",
			repositoryId: "repo",
			workspaceId: w.id,
			actor: agent,
			revision,
			baseRevision: base,
			kind: "source",
			title,
			contentHash: "hash",
			trust: "reported",
			storage: { repository: "r", providerId: "p", revision },
			at: 1_000,
		});
		c.workspace(w.id).publishedRevision = revision;
		const p = run(agent, { tool: "create_proposal", artifactId }) as { id: string };
		return { workspaceId: w.id, proposalId: p.id };
	};
	return { c, run, propose };
}
const items = (c: RepositoryController, viewer: Actor, role: RepositoryRole = "maintain") =>
	c.snapshot(authority(viewer, role)).attention!.items;

describe("attention projection", () => {
	it("separates what work needs from what this viewer may do", () => {
		const { c, run, propose } = setup();
		const missing = propose(mayaAgent, "Session renewal", r1);
		const reported = propose(luisAgent, "Token expiry", r2);
		run(luisAgent, {
			tool: "record_verification",
			proposalId: reported.proposalId,
			revision: r2,
			kind: "tests",
			outcome: "pass",
			reason: "12 passed",
		});
		const byMaya = items(c, maya);
		const mine = byMaya.find((item) => item.id === missing.proposalId)!;
		// Missing evidence is preparation for its owner; Maya owns it, so it is hers to prepare.
		expect(mine).toMatchObject({
			group: "preparation",
			ownerId: "maya",
			revision: r1,
			base: c0,
			actions: ["prepare_revision"],
			mine: true,
		});
		expect(mine.blockers.map((b) => b.kind)).toEqual(["evidence_missing", "approval_required"]);
		// Reported evidence needs a human maintainer to inspect and attest, then approve.
		const review = byMaya.find((item) => item.id === reported.proposalId)!;
		expect(review).toMatchObject({ group: "review", ownerId: "luis", actions: ["attest_evidence", "approve"], mine: true });
		// Maintain authority never makes another user's owner work available.
		const byLuis = items(c, luis);
		expect(byLuis.find((item) => item.id === missing.proposalId)).toMatchObject({ actions: ["inspect"], mine: false });
	});
	it("offers console decisions only to authenticated human maintainers", () => {
		const { c, run, propose } = setup();
		const change = propose(mayaAgent, "Retry", r1);
		run(maya, {
			tool: "record_verification",
			proposalId: change.proposalId,
			revision: r1,
			kind: "tests",
			outcome: "pass",
			reason: "ok",
			humanAttested: true,
		});
		expect(items(c, maya)[0]).toMatchObject({ group: "review", actions: ["approve"] });
		// The owner's agent and a write-only developer see the same work but cannot approve it.
		expect(items(c, mayaAgent)[0]).toMatchObject({ group: "review", actions: ["inspect"], mine: false });
		expect(items(c, luis, "write")[0]).toMatchObject({ actions: ["inspect"], mine: false });
		run(maya, { tool: "review_proposal", proposalId: change.proposalId, revision: r1, outcome: "approve", reason: "ok" });
		expect(items(c, maya)[0]).toMatchObject({ group: "promote", blockers: [], actions: ["promote"], mine: true });
		expect(items(c, luis, "read")[0]).toMatchObject({ group: "promote", actions: ["inspect"], mine: false });
	});
	it("classifies failing evidence and concerns, keeping every blocker in precedence order", () => {
		const { c, run, propose } = setup();
		const change = propose(mayaAgent, "Retry", r1);
		run(luisAgent, {
			tool: "record_verification",
			proposalId: change.proposalId,
			revision: r1,
			kind: "tests",
			outcome: "fail",
			reason: "2 failed",
		});
		run(luis, { tool: "review_proposal", proposalId: change.proposalId, revision: r1, outcome: "concern", reason: "Retry bound" });
		const [item] = items(c, luis);
		expect(item.group).toBe("preparation");
		expect(item.blockers).toEqual([
			{ kind: "evidence_failed", check: "tests" },
			{ kind: "concern", count: 1 },
			{ kind: "approval_required" },
		]);
		// Luis is a maintainer but not the owner: the failing evidence is the owner's to repair.
		expect(item).toMatchObject({ actions: ["inspect"], mine: false });
		expect(items(c, maya)[0]).toMatchObject({ actions: ["prepare_revision"], mine: true });
	});
	it("puts stale change bases into reconciliation with the exact comparison basis", () => {
		const { c, propose } = setup();
		const luisChange = propose(luisAgent, "Token expiry", r2);
		c.state.sourceHead = c1;
		const [item] = items(c, luis);
		expect(item).toMatchObject({ id: luisChange.proposalId, group: "reconciliation", actions: ["reconcile_with_git"], mine: true });
		expect(item.blockers[0]).toEqual({ kind: "base_stale", base: c0, canonical: c1 });
		expect(items(c, maya)[0]).toMatchObject({ actions: ["inspect"], mine: false });
	});
	it("surfaces diverged and missing-ancestry workspaces, but not contained published work or unknown ancestry", () => {
		const { c, run } = setup();
		const start = (title: string) => (run(mayaAgent, { tool: "start_workspace", title, baseRevision: c0 }) as { id: string }).id;
		const [diverged, behindBaseline, contained, unknown] = ["Diverged", "Baseline behind", "Contained", "Unknown"].map(start);
		const row = (
			workspaceId: string,
			relation: ReconciliationView["workspaces"][number]["relation"],
			basis: "published" | "baseline",
			missing = 0,
		) => ({
			workspaceId,
			revision: r3,
			basis,
			canonicalRevision: c1,
			relation,
			report: { state: "unknown" as const },
			incorporation: [],
			incorporationCounts: { present: 0, missing, unknown: 0 },
			incorporationTruncated: false,
		});
		const snapshot = c.snapshot(authority(maya));
		snapshot.reconciliation = {
			asOf: 1_000,
			observation: { enabled: false, state: "disabled", generation: 0, pending: 0, workspaces: {}, estimatedDailyOperations: 0 },
			workspaces: [
				row(diverged, "diverged", "published", 1),
				row(behindBaseline, "behind", "baseline"),
				row(contained, "behind", "published"),
				row(unknown, "unknown", "published"),
			],
			proposals: [],
		};
		const view = attentionView(snapshot, "maya");
		expect(view.items.map((item) => [item.title, item.blockers.map((b) => b.kind)])).toEqual([
			["Diverged", ["canonical_relation", "ancestry_missing"]],
			["Baseline behind", ["canonical_relation"]],
		]);
		expect(view.items[0]).toMatchObject({ subject: "workspace", group: "reconciliation", basis: "published", base: c1 });
		expect(view.ancestryUnavailable).toBe(1);
		// Another maintainer sees the same facts, waiting on the owner.
		expect(attentionView(snapshot, "luis").items.every((item) => !item.mine)).toBe(true);
	});
	it("treats an unsettled promotion as recovery for its promoting maintainer only, and blocks others last", () => {
		const { c, run, propose } = setup();
		const first = propose(mayaAgent, "First", r1);
		const second = propose(luisAgent, "Second", r2);
		run(maya, {
			tool: "record_verification",
			proposalId: first.proposalId,
			revision: r1,
			kind: "tests",
			outcome: "pass",
			reason: "ok",
			humanAttested: true,
		});
		run(maya, { tool: "review_proposal", proposalId: first.proposalId, revision: r1, outcome: "approve", reason: "ok" });
		c.proposal(first.proposalId).state = "promoting";
		const command: Command = { tool: "promote_proposal", proposalId: first.proposalId, idempotencyKey: "op" };
		c.state.promotions.push({
			id: "promotion",
			proposalId: first.proposalId,
			from: c0,
			to: r1,
			actor: maya,
			at: 1_000,
			state: "uncertain",
			operation: { id: "op", fingerprint: "f", reservationId: "r", phase: "attempted", command },
		});
		const byMaya = items(c, maya);
		expect(byMaya[0]).toMatchObject({ id: first.proposalId, group: "recovery", actions: ["reconcile_promotion"], mine: true });
		expect(byMaya[0].blockers).toEqual([{ kind: "promotion_unsettled" }]);
		// The other change keeps its own group; the pending promotion is listed last among its blockers.
		const other = byMaya.find((item) => item.id === second.proposalId)!;
		expect(other.blockers.at(-1)).toEqual({ kind: "promotion_pending" });
		expect(items(c, luis)[0]).toMatchObject({ id: first.proposalId, actions: ["inspect"], mine: false });
	});
	it("is a read-only projection that never changes the controller state", () => {
		const { c, propose } = setup();
		propose(mayaAgent, "Retry", r1);
		const before = JSON.stringify(c.state);
		items(c, maya);
		items(c, luis, "read");
		expect(JSON.stringify(c.state)).toBe(before);
	});
});
