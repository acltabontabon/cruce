import { describe, expect, it } from "vitest";
import { DirectoryController, initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController, WORKSPACE_TTL } from "../../src/core/platform.ts";
import type { Actor, Authority, Command, Repository, Workspace } from "../../src/shared/platform.ts";
import { authorizeMachine, CRUCE_TOOLS } from "../../src/shared/tools.ts";

const human: Actor = { id: "human", userId: "owner", name: "Cris", kind: "human" };
const agent: Actor = { id: "agent-a", userId: "owner", name: "Codex", kind: "agent", connectionId: "oauth-a" };
const repo: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "payments",
	defaultBranch: "trunk",
	createdAt: 0,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const authority = (actor = human): Authority => ({
	actor,
	namespaceId: "namespace",
	repositoryId: "repo",
	role: "owner",
	repositoryRole: "maintain",
	scopes: ["cruce:read", "workspace:write"],
});
const base = "a".repeat(40),
	head = "b".repeat(40);
function namespace() {
	return new NamespaceController(
		initialNamespace({ id: "namespace", name: "Team", handle: "team", kind: "shared", ownerId: "owner", createdAt: 0 }),
		100,
	);
}
function controller(now = 100) {
	let id = 0;
	return new RepositoryController(initialRepository(repo), now, () => `record-${++id}`);
}
function start(c: RepositoryController, actor = agent, checkout = "checkout") {
	const a = authority(actor);
	const s = c.command(
		{ tool: "start_workspace", repositoryId: "repo", namespaceId: "namespace", baseRevision: base, title: "Retry policy" },
		a,
	) as Workspace;
	c.command(
		{
			tool: "attach_workspace",
			repositoryId: "repo",
			namespaceId: "namespace",
			workspaceId: s.id,
			execution: { id: s.id, checkoutId: checkout, machineId: "machine", kind: "worktree", owned: true },
		},
		a,
	);
	return s;
}
const cmd = (tool: string, extra: Partial<Command> = {}): Command => ({ tool, namespaceId: "namespace", repositoryId: "repo", ...extra });
describe("namespace ownership", () => {
	it("creates one personal namespace per issuer and subject, resolving handle collisions", () => {
		let n = 0;
		const c = new DirectoryController({ users: [], namespaces: [] }, 1, () => `${++n}`);
		const first = c.login("issuer", "a", "cris@example.com");
		expect(c.login("issuer", "a", "renamed@example.com").id).toBe(first.id);
		c.login("issuer", "b", "cris@elsewhere.com");
		expect(c.state.namespaces.map((w) => w.handle)).toEqual(["cris", "cris-1"]);
		c.rename(first.personalNamespaceId, { handle: "cris-new", name: "Cris new" });
		expect(c.state.users[0].personalNamespaceId).toBe(first.personalNamespaceId);
	});
	it("combines explicit and team grants, caps viewers, and removes revoked access", () => {
		const c = namespace(),
			a = authority();
		c.member(a, "dev", "developer");
		c.member(a, "viewer", "viewer");
		c.team(a, "platform", "Platform", ["dev", "viewer"]);
		c.repository(a, { ...repo, grants: [{ subject: "team", id: "platform", role: "maintain" }] });
		expect(c.authority({ ...human, userId: "dev" }, repo.id).repositoryRole).toBe("write");
		expect(c.authority({ ...human, userId: "viewer" }, repo.id).repositoryRole).toBe("read");
		c.member(a, "dev");
		expect(() => c.authority({ ...human, userId: "dev" }, repo.id)).toThrow("denied");
		expect(c.state.teams[0].members).toEqual(["viewer"]);
	});
	it("does not grant access from remote names, client labels or unapproved OAuth repositories", () => {
		const c = namespace();
		c.repository(authority(), repo);
		expect(() => c.authority(agent, "repo", ["cruce:read"], [])).toThrow("not authorized");
		expect(c.authority(agent, "repo", ["cruce:read"], ["repo"]).actor.kind).toBe("agent");
		expect(() => c.authority({ ...human, userId: "stranger" }, "repo")).toThrow("denied");
	});
	it("binds invitations to verified email and expiry; acceptance is idempotent", () => {
		const c = namespace();
		c.invite(authority(), { id: "invite", email: "maya@example.com", role: "developer", tokenHash: "hash", expiresAt: 200 });
		const user = {
			id: "maya",
			issuer: "issuer",
			subject: "maya",
			email: "wrong@example.com",
			name: "Maya",
			personalNamespaceId: "personal",
		};
		expect(() => c.accept(user, "hash")).toThrow("invalid");
		c.accept({ ...user, email: "maya@example.com" }, "hash");
		c.accept({ ...user, email: "maya@example.com" }, "hash");
		expect(c.state.members.maya).toBe("developer");
		const late = new NamespaceController(c.state, 300);
		expect(() => late.accept({ ...user, email: "maya@example.com" }, "hash")).toThrow("expired");
	});
	it("keeps personal ownership singular and ownership changes privileged", () => {
		const c = namespace();
		expect(() => c.member(authority(), "next", "owner")).toThrow("ownership");
		c.state.namespace.kind = "personal";
		expect(() => c.member(authority(), "next", "developer")).toThrow("one owner");
	});
	it("does not silently bypass budgets for humans or a new resource policy on retry", () => {
		const c = namespace();
		c.repository(authority(), repo);
		c.state.policy.dailyLimit = 0;
		expect(() => c.reserve(authority(), "human", "inputs", "repository.create")).toThrow("budget");
		c.state.policy.dailyLimit = 1;
		c.reserve(authority(agent), "retry", "inputs", "preview.deploy", "workspace");
		c.state.policy.rules["preview.deploy"] = "deny";
		expect(() => c.reserve(authority(agent), "retry", "inputs", "preview.deploy", "workspace")).toThrow("policy denies");
	});
	it("serializes concurrent first-login decisions and denies cross-namespace repository grants", async () => {
		let id = 0;
		const c = new DirectoryController({ users: [], namespaces: [] }, 100, () => `id-${++id}`);
		const users = await Promise.all(Array.from({ length: 20 }, async () => c.login("issuer", "subject", "user@example.com")));
		expect(new Set(users.map((u) => u.id)).size).toBe(1);
		expect(c.state.namespaces).toHaveLength(1);
		const w = namespace();
		expect(() => w.repository(authority(), { ...repo, namespaceId: "other" })).toThrow();
	});
	it("shares reservations across repositories and counts uncertain retries once", () => {
		const c = namespace(),
			a = authority(agent);
		c.repository(authority(), repo);
		c.repository(authority(), { ...repo, id: "second", name: "second" });
		c.state.policy.dailyLimit = 1;
		const reservation = c.reserve(a, "operation", "exact inputs", "preview.deploy", "workspace");
		reservation.state = "uncertain";
		expect(c.reserve(a, "operation", "exact inputs", "preview.deploy", "workspace")).toBe(reservation);
		expect(() => c.reserve({ ...a, repositoryId: "second" }, "other", "inputs", "preview.deploy", "workspace")).toThrow("budget");
		expect(() => c.reserve(a, "operation", "different", "preview.deploy", "workspace")).toThrow("reused");
		expect(() => c.reserve(a, "production", "inputs", "production.deploy")).toThrow("Human");
	});
});
describe("actor-neutral workspaces", () => {
	it("derives upstream awareness without changing starting revisions, presence or state", () => {
		const c = controller(),
			s = start(c);
		expect(c.workspaceUpdates(s)).toMatchObject({ status: "unknown", baselineRevision: base });
		c.state.refs.push({ ref: "trunk", revision: head, workspaceId: s.id, actorId: agent.id, at: 100, trust: "reported" });
		expect(c.workspaceUpdates(s).status).toBe("unknown");
		c.state.sourceHead = head;
		const before = structuredClone(c.state);
		expect(c.snapshot(authority()).workspaceUpdates[s.id]).toMatchObject({ status: "available", revision: head, trust: "accepted" });
		expect(c.state).toEqual(before);
		s.integratedRevision = head;
		expect(c.workspaceUpdates(s).status).toBe("current");
		c.state.sourceHead = "c".repeat(40);
		expect(c.workspaceUpdates(s)).toMatchObject({ status: "available", baselineRevision: head, trust: "accepted" });
		s.publishedRevision = c.state.sourceHead;
		expect(c.workspaceUpdates(s).status).toBe("current");
		expect(s.baseRevision).toBe(base);
	});
	it("isolates writers even after presence expiry; observer shares context safely", () => {
		const c = controller(),
			s = start(c);
		const later = new RepositoryController(c.state, WORKSPACE_TTL + 101, () => "second");
		expect(later.snapshot(authority()).workspaces[0].state).toBe("disconnected");
		expect(() => start(later, { ...agent, id: "agent-b", connectionId: "oauth-b" })).toThrow("already reserved");
		expect(s.baseRevision).toBe(base);
	});
	it("reconnects a disconnected writer and permits a read-only observer without releasing ownership", () => {
		const c = controller(),
			s = start(c);
		const later = new RepositoryController(c.state, WORKSPACE_TTL + 101, () => "observer");
		expect(later.snapshot(authority()).workspaces[0].state).toBe("disconnected");
		later.command(cmd("heartbeat", { workspaceId: s.id }), authority(agent));
		expect(later.snapshot(authority()).workspaces[0].state).toBe("active");
		const observer = later.command(
			cmd("start_workspace", { mode: "read", title: "Inspect", baseRevision: base }),
			authority(human),
		) as Workspace;
		later.command(
			cmd("attach_workspace", {
				workspaceId: observer.id,
				execution: { id: "observer", checkoutId: "checkout", machineId: "machine", kind: "checkout", owned: false },
			}),
			authority(human),
		);
		expect(observer.state).toBe("active");
		expect(() =>
			later.command(cmd("report_change", { workspaceId: observer.id, revision: base, changes: [] }), authority(human)),
		).toThrow();
	});
	it("human and agent work overlap without blocking; renames and binary paths count", () => {
		const c = controller(),
			s = start(c),
			h = start(c, human, "human-checkout");
		c.command(
			cmd("report_change", {
				workspaceId: s.id,
				revision: head,
				changes: [{ path: "new.bin", previousPath: "old.bin", status: "renamed", binary: true }],
			}),
			authority(agent),
		);
		c.command(
			cmd("report_change", { workspaceId: h.id, revision: base, changes: [{ path: "old.bin", status: "modified", binary: true }] }),
			authority(),
		);
		expect(c.overlaps()).toMatchObject([{ surface: "old.bin", kind: "file", evidence: "reported" }]);
		expect(s.state).toBe("active");
		expect(s.baseRevision).toBe(base);
	});
	it("cannot impersonate a workspace owner or attach an agent to a shared checkout", () => {
		const c = controller(),
			s = start(c);
		expect(() => c.command(cmd("heartbeat", { workspaceId: s.id }), authority({ ...agent, connectionId: "other" }))).toThrow("connection");
		const next = c.command(cmd("start_workspace", { title: "Other", baseRevision: base }), authority(agent)) as Workspace;
		expect(() =>
			c.command(
				cmd("attach_workspace", {
					workspaceId: next.id,
					execution: { id: "ctx", checkoutId: "unique", machineId: "machine", kind: "checkout", owned: false },
				}),
				authority(agent),
			),
		).toThrow("dedicated");
	});
	it("completion retains commits, artifacts and immutable base", () => {
		const c = controller(),
			s = start(c);
		s.commits = [head];
		c.addArtifact({
			id: "artifact",
			namespaceId: "namespace",
			repositoryId: "repo",
			workspaceId: s.id,
			actor: agent,
			revision: head,
			kind: "source",
			title: "Source",
			contentHash: "hash",
			trust: "reported",
			storage: { repository: "store", revision: head },
			at: 100,
		});
		c.command(cmd("end_workspace", { workspaceId: s.id }), authority(agent));
		expect(c.state.artifacts).toHaveLength(1);
		expect(s.commits).toEqual([head]);
		expect(s.baseRevision).toBe(base);
		expect(() => c.command(cmd("heartbeat", { workspaceId: s.id }), authority(agent))).toThrow("ended");
	});
	it("does not expose heartbeat as a pure MCP read or allow human-only machine actions", () => {
		expect(CRUCE_TOOLS.find((t) => t.name === "heartbeat")?.mutation).toBe(true);
		expect(() => authorizeMachine(authority(agent), cmd("promote_proposal"))).toThrow("denied");
		expect(() => authorizeMachine(authority(agent), cmd("record_verification", { humanAttested: true }))).toThrow();
	});
});
describe("revision-bound review and deployment", () => {
	it("pins a proposal's base to its artifact even after later workspace integration", () => {
		const c = controller(),
			s = start(c);
		c.addArtifact({
			id: "reconciled",
			namespaceId: "namespace",
			repositoryId: "repo",
			workspaceId: s.id,
			actor: agent,
			revision: "c".repeat(40),
			baseRevision: head,
			kind: "source",
			title: "Reconciled",
			contentHash: "hash",
			trust: "reported",
			storage: { repository: "fork", revision: "c".repeat(40) },
			at: 100,
		});
		s.integratedRevision = "d".repeat(40);
		const p = c.command(cmd("create_proposal", { artifactId: "reconciled" }), authority(agent)) as { base: string };
		expect(p.base).toBe(head);
		expect(s.baseRevision).toBe(base);
	});
	function proposed() {
		const c = controller(),
			s = start(c);
		c.addArtifact({
			id: "source",
			namespaceId: "namespace",
			repositoryId: "repo",
			workspaceId: s.id,
			actor: agent,
			revision: head,
			kind: "source",
			title: "Source",
			contentHash: "hash",
			trust: "reported",
			storage: { repository: "source", revision: head },
			at: 100,
		});
		const p = c.command(cmd("create_proposal", { artifactId: "source" }), authority(agent)) as { id: string };
		return { c, s, p: c.proposal(p.id) };
	}
	it("requires exact revision approval and reasoned resolution", () => {
		const { c, p } = proposed();
		expect(() =>
			c.command(cmd("review_proposal", { proposalId: p.id, revision: base, outcome: "approve", reason: "yes" }), authority()),
		).toThrow("exact");
		c.command(cmd("review_proposal", { proposalId: p.id, revision: head, outcome: "approve", reason: "Inspected" }), authority());
		c.command(
			cmd("review_proposal", { proposalId: p.id, revision: head, outcome: "concern", reason: "Review retry cap" }),
			authority(agent),
		);
		expect(c.readiness(p).ready).toBe(false);
		c.command(cmd("resolve_review", { proposalId: p.id, reviewIndex: 1, reason: "Bound verified" }), authority());
		expect(c.readiness(p).ready).toBe(true);
		c.state.sourceHead = "c".repeat(40);
		expect(c.readiness(p).ready).toBe(false);
	});
	it("derives deployment revision from immutable source artifact and traces both directions", () => {
		const { c, s, p } = proposed();
		const env = c.command(
			cmd("configure_environment", { environment: { name: "Production", kind: "production", workerName: "payments", smokeChecks: [] } }),
			authority(),
		) as { id: string };
		expect(() => c.prepareDeployment(cmd("deploy_artifact", { environmentId: env.id, artifactId: "source" }), authority(agent))).toThrow(
			"Human",
		);
		expect(() => c.prepareDeployment(cmd("deploy_artifact", { environmentId: env.id, artifactId: "source" }), authority())).toThrow(
			"exact-revision",
		);
		c.command(cmd("review_proposal", { proposalId: p.id, revision: head, outcome: "approve", reason: "Inspected" }), authority());
		const d = c.prepareDeployment(cmd("deploy_artifact", { environmentId: env.id, artifactId: "source", revision: base }), authority());
		expect(d.revision).toBe(head);
		expect(c.trace(d.id).some((r) => r.record.id === s.id)).toBe(true);
		expect(c.trace(s.id).some((r) => r.record.id === d.id)).toBe(true);
		d.state = "deployed";
		const rollback = c.prepareDeployment(
			cmd("deploy_artifact", { environmentId: env.id, artifactId: "source", deploymentId: d.id }),
			authority(),
		);
		expect(rollback.rollbackOf).toBe(d.id);
		expect(rollback.artifactId).toBe("source");
	});
});
