import { describe, expect, it } from "vitest";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Authority, Command, Repository, ReviewNote, Workspace } from "../../src/shared/platform.ts";
import { authorizeMachine, CRUCE_TOOLS, HUMAN_TOOLS, toolByName } from "../../src/shared/tools.ts";

const agent: Actor = { id: "owner-codex", userId: "owner", name: "Codex", kind: "agent", connectionId: "oauth-owner" };
const reviewer: Actor = { id: "sam", userId: "sam", name: "Sam Okafor", kind: "human" };
const terminal: Actor = { id: "sam-terminal", userId: "sam", name: "Sam terminal", kind: "human", connectionId: "bridge-sam" };
const repo: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "payments",
	defaultBranch: "main",
	createdAt: 0,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const base = "a".repeat(40),
	first = "b".repeat(40),
	second = "c".repeat(40);
const authority = (actor: Actor, role: "read" | "write" | "maintain" = "maintain"): Authority => ({
	actor,
	namespaceId: "namespace",
	repositoryId: "repo",
	role: role === "read" ? "viewer" : "maintainer",
	repositoryRole: role,
	scopes: ["cruce:read", "workspace:write", "revision:publish", "change:write"],
});
const cmd = (tool: string, extra: Partial<Command> = {}): Command => ({ tool, namespaceId: "namespace", repositoryId: "repo", ...extra });

function publish(c: RepositoryController, s: Workspace, revision: string, id: string) {
	c.addArtifact({
		id,
		namespaceId: "namespace",
		repositoryId: "repo",
		workspaceId: s.id,
		actor: agent,
		revision,
		baseRevision: base,
		kind: "source",
		title: "Bounded retry policy",
		contentHash: id,
		trust: "reported",
		storage: { repository: "source", providerId: "source", revision },
		at: 100,
	});
	return c.proposal((c.command(cmd("create_proposal", { artifactId: id }), authority(agent)) as { id: string }).id);
}
function change() {
	let n = 0;
	const c = new RepositoryController(initialRepository(repo), 100, () => `record-${++n}`);
	c.state.sourceHead = base;
	const s = c.command(cmd("start_workspace", { baseRevision: base, title: "Implement retry policy" }), authority(agent)) as Workspace;
	return { c, s, p: publish(c, s, first, "first") };
}
const note = (c: RepositoryController, actor: Actor, fields: Partial<Command>) =>
	c.command(cmd("add_review_note", { kind: "concern", body: "Cap attempts", ...fields }), authority(actor)) as ReviewNote;

describe("review notes", () => {
	it("anchors a note to a line of an exact revision and blocks readiness until a human resolves it", () => {
		const { c, p } = change();
		c.command(cmd("review_proposal", { proposalId: p.id, revision: first, outcome: "approve", reason: "Read it" }), authority(reviewer));
		expect(c.readiness(p).ready).toBe(true);
		const n = note(c, reviewer, {
			proposalId: p.id,
			revision: first,
			path: "src/http/client.ts",
			line: 21,
			anchorRevision: first,
			lineText: "if (!shouldRetry(error, attempt)) throw error;",
		});
		expect(n).toMatchObject({ kind: "concern", revision: first, anchor: { path: "src/http/client.ts", line: 21, revision: first } });
		expect(c.readiness(p)).toMatchObject({ ready: false, checks: { concerns: 1, answered: 0 } });
		expect(c.readiness(p).reasons).toContain("Review concern requires a reasoned human resolution");
		expect(() => c.command(cmd("resolve_review_note", { noteId: n.id, reason: "Fine" }), authority(agent))).toThrow();
		expect(() => c.command(cmd("resolve_review_note", { noteId: n.id, reason: "Fine" }), authority(terminal))).toThrow();
		c.command(cmd("resolve_review_note", { noteId: n.id, reason: "Verified the cap" }), authority(reviewer));
		expect(c.readiness(p).ready).toBe(true);
		expect(() => c.command(cmd("resolve_review_note", { noteId: n.id, reason: "Again" }), authority(reviewer))).toThrow("already resolved");
	});

	it("never blocks on comments and refuses notes that name another revision or an unrelated anchor", () => {
		const { c, p } = change();
		note(c, reviewer, { proposalId: p.id, revision: first, kind: "comment", body: "Name the 5" });
		expect(c.readiness(p).checks.concerns).toBe(0);
		expect(() => note(c, reviewer, { proposalId: p.id, revision: second })).toThrow("exact revision");
		expect(() => note(c, reviewer, { proposalId: p.id, revision: first, kind: "nit" })).toThrow("concern or comment");
		expect(() => note(c, reviewer, { proposalId: p.id, revision: first, path: "a.ts", line: 1, anchorRevision: second })).toThrow("Anchor");
		expect(() => note(c, { ...reviewer, id: "viewer" }, { proposalId: p.id, revision: first })).not.toThrow();
		expect(() =>
			c.command(cmd("add_review_note", { proposalId: p.id, revision: first, kind: "comment", body: "x" }), authority(reviewer, "read")),
		).toThrow("write permission");
	});

	it("carries unresolved notes to the change that supersedes theirs, with replies citing published revisions", () => {
		const { c, s, p } = change();
		const n = note(c, reviewer, { proposalId: p.id, revision: first, path: "src/retry.ts", line: 3, anchorRevision: first, lineText: "x" });
		const resolved = note(c, reviewer, { proposalId: p.id, revision: first, kind: "comment", body: "Nice" });
		c.command(cmd("resolve_review_note", { noteId: resolved.id, reason: "Thanks" }), authority(reviewer));
		const next = publish(c, s, second, "second");
		expect(p).toMatchObject({ state: "rejected", supersededBy: next.id });
		// Republishing never drops a concern, and approval of the earlier revision never carries over.
		expect(c.readiness(next).checks).toMatchObject({ concerns: 1, approved: false });
		expect(() =>
			c.command(cmd("reply_review_note", { noteId: n.id, body: "Fixed", citedRevision: "d".repeat(40) }), authority(agent)),
		).toThrow("published revision");
		c.command(cmd("reply_review_note", { noteId: n.id, body: "Fixed in the new revision", citedRevision: second }), authority(agent));
		expect(c.readiness(next).checks).toMatchObject({ concerns: 1, answered: 1 });
		const read = c.command(cmd("get_review_notes", { workspaceId: s.id }), authority(agent)) as ReturnType<
			RepositoryController["reviewNotes"]
		>;
		expect(read.change).toMatchObject({ id: next.id, revision: second });
		expect(read.counts).toEqual({ awaitingOwner: 0, awaitingReviewer: 1, resolved: 1 });
		expect(read.notes.map((x) => [x.id, x.state, x.change])).toEqual([
			[n.id, "awaiting_reviewer", p.number],
			[resolved.id, "resolved", p.number],
		]);
		// A reviewer's follow-up hands the note back to the owner.
		c.command(cmd("reply_review_note", { noteId: n.id, body: "Also cover refunds" }), authority(reviewer));
		expect(c.readiness(next).checks.answered).toBe(0);
		// An anchor may name any revision of the thread, including the review base.
		expect(() => note(c, reviewer, { proposalId: next.id, revision: second, path: "a.ts", line: 1, anchorRevision: first })).not.toThrow();
		expect(() => note(c, reviewer, { proposalId: next.id, revision: second, path: "a.ts", line: 1, anchorRevision: base })).not.toThrow();
	});

	it("ends the thread when a human closes the change", () => {
		const { c, p } = change();
		const n = note(c, reviewer, { proposalId: p.id, revision: first });
		c.command(cmd("reject_proposal", { proposalId: p.id, reason: "Wrong approach" }), authority(reviewer));
		expect(() => c.command(cmd("reply_review_note", { noteId: n.id, body: "Ok" }), authority(agent))).toThrow("not open");
		expect(() => c.command(cmd("resolve_review_note", { noteId: n.id, reason: "Ok" }), authority(reviewer))).toThrow("not open");
	});

	it("reads without mutating and stays within its bounds", () => {
		const { c, s, p } = change();
		const before = structuredClone(c.state);
		c.command(cmd("get_review_notes", { workspaceId: s.id }), authority(agent));
		c.command(cmd("get_review_notes", { proposalId: p.id }), authority(agent));
		expect(c.state).toEqual(before);
		for (let i = 0; i < 200; i++) note(c, reviewer, { proposalId: p.id, revision: first, kind: "comment", body: `Note ${i}` });
		expect(() => note(c, reviewer, { proposalId: p.id, revision: first })).toThrow("limit");
		const n = p.notes![0];
		for (let i = 0; i < 20; i++) c.command(cmd("reply_review_note", { noteId: n.id, body: `Reply ${i}` }), authority(agent));
		expect(() => c.command(cmd("reply_review_note", { noteId: n.id, body: "One more" }), authority(agent))).toThrow("limit");
	});

	it("lets agents read, add and reply under change scopes but keeps resolution human", () => {
		expect(toolByName("get_review_notes")).toMatchObject({ scope: "cruce:read", mutation: false });
		expect(toolByName("add_review_note")).toMatchObject({ scope: "change:write", mutation: true, cost: "none" });
		expect(toolByName("reply_review_note")).toMatchObject({ scope: "change:write", mutation: true, cost: "none" });
		expect(CRUCE_TOOLS.some((t) => t.name === "resolve_review_note")).toBe(false);
		expect(HUMAN_TOOLS.has("resolve_review_note")).toBe(true);
		expect(() => authorizeMachine({ ...authority(agent), scopes: ["cruce:read"] }, cmd("reply_review_note"))).toThrow("capability denied");
		expect(() => authorizeMachine(authority(agent), cmd("resolve_review_note"))).toThrow("capability denied");
	});
});
