import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_SCOPES, SCOPE_LABELS, SCOPES } from "../../src/core/capabilities.ts";
import { DomainError, publicError } from "../../src/core/errors.ts";
import { DirectoryController, initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController, WORKSPACE_TTL } from "../../src/core/platform.ts";
import type { Actor, Authority, Command, Repository, Workspace } from "../../src/shared/platform.ts";
import { CommandInput, RESOURCE_ACTIONS } from "../../src/shared/platform.ts";
import { authorizeMachine, CRUCE_TOOLS, HUMAN_TOOLS, toolByName } from "../../src/shared/tools.ts";

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

describe("canonical Git product boundary", () => {
	it.each(["request_preview", "configure_environment", "deploy_artifact"])("does not expose or execute %s", (tool) => {
		expect(toolByName(tool)).toBeUndefined();
		expect(HUMAN_TOOLS.has(tool)).toBe(false);
		expect(() => controller().command(cmd(tool), authority())).toThrow("Unsupported repository command");
		expect(() => authorizeMachine(authority(agent), cmd(tool))).toThrow("capability denied");
	});
	it.each(["environmentId", "environment", "deploymentId"])("rejects removed command field %s", (field) => {
		expect(CommandInput.safeParse({ tool: "get_repository", [field]: field === "environment" ? {} : "old" }).success).toBe(false);
	});
	it("exposes only coordination scopes, resource actions and state", () => {
		expect(SCOPES).not.toContain("preview:request");
		expect(DEFAULT_AGENT_SCOPES).not.toContain("preview:request");
		expect(SCOPE_LABELS).not.toHaveProperty("preview:request");
		expect(RESOURCE_ACTIONS).toEqual([
			"repository.create",
			"workspace.fork",
			"workspace.cleanup",
			"revision.publish",
			"artifact.publish",
			"source.read",
		]);
		const snapshot = controller().snapshot(authority());
		expect(snapshot).not.toHaveProperty("environments");
		expect(snapshot).not.toHaveProperty("deployments");
		expect(namespace().state.policy).not.toHaveProperty("previewsPerWorkspace");
	});
});
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
/** The local execution descriptor a bridge sends with its reports. */
function exec(s: Workspace) {
	const { attachedBy: _, attachedAt: __, ...execution } = s.execution!;
	return execution;
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
		const before = structuredClone(c.state);
		expect(c.resolve("issuer", "a").id).toBe(first.id);
		for (const [issuer, subject] of [
			["other", "a"],
			["issuer", "unknown"],
		])
			expect(() => c.resolve(issuer, subject)).toThrow("Sign in to initialize");
		expect(c.state).toEqual(before);
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
		c.reserve(authority(agent), "retry", "inputs", "workspace.fork", "workspace");
		c.state.policy.rules["workspace.fork"] = "deny";
		expect(() => c.reserve(authority(agent), "retry", "inputs", "workspace.fork", "workspace")).toThrow("policy denies");
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
		const reservation = c.reserve(a, "operation", "exact inputs", "workspace.fork", "workspace");
		reservation.state = "uncertain";
		expect(c.reserve(a, "operation", "exact inputs", "workspace.fork", "workspace")).toBe(reservation);
		expect(() => c.reserve({ ...a, repositoryId: "second" }, "other", "inputs", "workspace.fork", "workspace")).toThrow("budget");
		expect(() => c.reserve(a, "operation", "different", "workspace.fork", "workspace")).toThrow("reused");
		c.state.repositories[0].policy.resourceRules["workspace.fork"] = "approval";
		expect(() => c.reserve(a, "operation", "exact inputs", "workspace.fork", "workspace")).toThrow("Human");
		c.state.repositories[0].policy.resourceRules["workspace.fork"] = "deny";
		expect(() => c.reserve(a, "operation", "exact inputs", "workspace.fork", "workspace")).toThrow("policy denies");
	});
	it("gates explicit source reads for repository readers and rechecks policy before retry", () => {
		const c = namespace();
		c.repository(authority(), repo);
		const reader = { ...authority(agent), repositoryRole: "read" as const };
		const r = c.reserve(reader, "inspect", "exact revision", "source.read");
		expect(c.reserve(reader, "inspect", "exact revision", "source.read")).toBe(r);
		expect(c.budget().used).toBe(1);
		expect(() => c.reserve(reader, "publish", "revision", "revision.publish")).toThrow("write permission");
		c.state.repositories[0].policy.resourceRules["source.read"] = "approval";
		expect(() => c.reserve(reader, "inspect", "exact revision", "source.read")).toThrow("Human");
		c.state.policy.rules["source.read"] = "deny";
		expect(() => c.reserve(authority(), "inspect2", "exact revision", "source.read")).toThrow("policy denies");
	});
});
describe("actor-neutral workspaces", () => {
	it("derives upstream awareness without changing starting revisions, presence or state", () => {
		const c = controller(),
			s = start(c);
		expect(c.workspaceUpdates(s)).toMatchObject({ status: "unknown", baselineRevision: base });
		s.headRevision = head;
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
	it("isolates writers even after presence expiry", () => {
		const c = controller(),
			s = start(c);
		const later = new RepositoryController(c.state, WORKSPACE_TTL + 101, () => "second");
		expect(later.snapshot(authority()).workspaces[0].state).toBe("disconnected");
		expect(() => start(later, { ...agent, id: "agent-b", connectionId: "oauth-b" })).toThrow("already reserved");
		expect(s.baseRevision).toBe(base);
	});
	it("reconnects a disconnected writer without releasing ownership", () => {
		const c = controller(),
			s = start(c);
		const later = new RepositoryController(c.state, WORKSPACE_TTL + 101, () => "later");
		expect(later.snapshot(authority()).workspaces[0].state).toBe("disconnected");
		expect(s.execution).toBeDefined();
		later.command(cmd("heartbeat", { workspaceId: s.id, execution: exec(s) }), authority(agent));
		expect(later.snapshot(authority()).workspaces[0].state).toBe("active");
		expect(CommandInput.safeParse({ tool: "start_workspace", mode: "read" }).success).toBe(false);
	});
	it("belongs to its owner across connections and tools, never to one session", () => {
		const c = controller(),
			s = start(c);
		const claude: Actor = { id: "agent-c", userId: "owner", name: "Claude Code", kind: "agent", connectionId: "oauth-c" };
		const stranger: Actor = { id: "agent-x", userId: "someone-else", name: "Codex", kind: "agent", connectionId: "oauth-x" };
		expect(s).toMatchObject({ ownerId: "owner", createdBy: { id: agent.id } });
		expect(s).not.toHaveProperty("actor");
		c.command(cmd("heartbeat", { workspaceId: s.id, execution: exec(s) }), authority(claude));
		c.command(cmd("report_change", { workspaceId: s.id, execution: exec(s), revision: head, changes: [] }), authority(human));
		expect(() => c.command(cmd("heartbeat", { workspaceId: s.id, execution: exec(s) }), authority(stranger))).toThrow("another user");
		expect(() =>
			c.command(cmd("heartbeat", { workspaceId: s.id, execution: { ...exec(s), checkoutId: "elsewhere" } }), authority(agent)),
		).toThrow("different execution");
		expect(() => c.command(cmd("report_change", { workspaceId: s.id, revision: head, changes: [] }), authority(agent))).toThrow(
			"execution context required",
		);
	});
	it("detaches explicitly and continues from another checkout, tool and machine", () => {
		const c = controller(),
			s = start(c);
		const claude: Actor = { id: "agent-c", userId: "owner", name: "Claude Code", kind: "agent", connectionId: "oauth-c" };
		s.fork = { name: "fork", id: "fork-id", remote: "remote", state: "ready" };
		const elsewhere = { id: s.id, checkoutId: "laptop-2", machineId: "machine-2", kind: "worktree" as const, owned: true };
		expect(() => c.command(cmd("attach_workspace", { workspaceId: s.id, execution: elsewhere }), authority(claude))).toThrow(
			"detach it first",
		);
		c.command(
			cmd("report_change", { workspaceId: s.id, execution: exec(s), revision: head, changes: [{ path: "a.ts", status: "modified" }] }),
			authority(agent),
		);
		expect(c.snapshot(authority()).executionRelease[s.id]).toEqual({ ready: true, reasons: [] });
		c.command(cmd("detach_workspace", { workspaceId: s.id }), authority(human));
		expect(s).toMatchObject({ state: "detached", headRevision: head, baseRevision: base, changes: [] });
		expect(s.execution).toBeUndefined();
		expect(c.snapshot(authority()).executionRelease[s.id].ready).toBe(false);
		expect(() => c.command(cmd("heartbeat", { workspaceId: s.id, execution: elsewhere }), authority(agent))).toThrow("Attach");
		c.command(cmd("attach_workspace", { workspaceId: s.id, execution: elsewhere }), authority(claude));
		expect(s).toMatchObject({
			state: "active",
			fork: { id: "fork-id" },
			execution: { checkoutId: "laptop-2", attachedBy: { id: "agent-c" } },
		});
		expect(c.state.activity.map((e) => e.kind)).toEqual(expect.arrayContaining(["execution_attached", "execution_detached"]));
		expect(() => c.command(cmd("detach_workspace", { workspaceId: s.id }), authority({ ...human, userId: "someone-else" }))).toThrow(
			"another user",
		);
	});
	it("human and agent work overlap without blocking; renames and binary paths count", () => {
		const c = controller(),
			s = start(c),
			h = start(c, human, "human-checkout");
		c.command(
			cmd("report_change", {
				workspaceId: s.id,
				execution: exec(s),
				revision: head,
				changes: [{ path: "new.bin", previousPath: "old.bin", status: "renamed", binary: true }],
			}),
			authority(agent),
		);
		c.command(
			cmd("report_change", {
				workspaceId: h.id,
				execution: exec(h),
				revision: base,
				changes: [{ path: "old.bin", status: "modified", binary: true }],
			}),
			authority(),
		);
		expect(c.overlaps()).toMatchObject([{ surface: "old.bin", kind: "file", evidence: "reported" }]);
		expect(s.state).toBe("active");
		expect(s.baseRevision).toBe(base);
	});
	it("cannot act for another user's workspace or attach an agent to a shared checkout", () => {
		const c = controller(),
			s = start(c);
		expect(() =>
			c.command(
				cmd("heartbeat", { workspaceId: s.id, execution: exec(s) }),
				authority({ ...agent, userId: "other", connectionId: "other" }),
			),
		).toThrow("another user");
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
			storage: { repository: "store", providerId: "store", revision: head },
			at: 100,
		});
		c.command(cmd("end_workspace", { workspaceId: s.id }), authority(agent));
		expect(c.state.artifacts).toHaveLength(1);
		expect(s.commits).toEqual([head]);
		expect(s.baseRevision).toBe(base);
		expect(() => c.command(cmd("heartbeat", { workspaceId: s.id, execution: exec(s) }), authority(agent))).toThrow("ended");
	});
	it("does not expose heartbeat as a pure MCP read or allow human-only machine actions", () => {
		expect(CRUCE_TOOLS.find((t) => t.name === "heartbeat")?.mutation).toBe(true);
		expect(() => authorizeMachine(authority(agent), cmd("promote_proposal"))).toThrow("denied");
		expect(() => authorizeMachine(authority(agent), cmd("record_verification", { humanAttested: true }))).toThrow();
	});
});
describe("revision-bound review", () => {
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
			storage: { repository: "fork", providerId: "fork", revision: "c".repeat(40) },
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
			storage: { repository: "source", providerId: "source", revision: head },
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

	it("derives recovery only for the authorized operation owner and preserves review readiness", () => {
		const { c, p } = proposed();
		c.command(cmd("review_proposal", { proposalId: p.id, revision: head, outcome: "approve", reason: "Inspected" }), authority());
		const command = cmd("promote_proposal", { proposalId: p.id, idempotencyKey: "persisted-key" });
		const promotion: import("../../src/shared/platform.ts").Promotion = {
			id: "pending",
			proposalId: p.id,
			from: base,
			to: head,
			actor: human,
			at: 100,
			state: "uncertain",
			operation: { id: "operation", fingerprint: "input", reservationId: "reservation", phase: "attempted", command },
		};
		c.state.promotions.push(promotion);
		p.state = "promoting";
		expect(c.readiness(p).ready).toBe(false);
		expect(c.snapshot(authority()).promotionRecovery[p.id]).toEqual({ command, ready: true, reasons: [] });
		expect(c.snapshot(authority(agent)).promotionRecovery).toEqual({});
		expect(c.snapshot({ ...authority(), repositoryRole: "read" }).promotionRecovery).toEqual({});
		expect(c.snapshot(authority({ ...human, id: "other-human" })).promotionRecovery).toEqual({});
		p.state = "open";
		c.command(cmd("review_proposal", { proposalId: p.id, revision: head, outcome: "concern", reason: "Recheck" }), authority(agent));
		p.state = "promoting";
		// An update that may have reached canonical is only observed; readiness gates the unsent update.
		expect(c.snapshot(authority()).promotionRecovery[p.id]).toEqual({ command, ready: true, reasons: [] });
		promotion.operation!.phase = "prepared";
		expect(c.snapshot(authority()).promotionRecovery[p.id].ready).toBe(false);
		promotion.state = "failed";
		expect(c.snapshot(authority()).promotionRecovery).toEqual({});
	});
	it("traces source, workspace, review evidence and canonical promotion in both directions", () => {
		const { c, s, p } = proposed();
		const verification = c.command(
			cmd("record_verification", {
				proposalId: p.id,
				revision: head,
				kind: "tests",
				outcome: "pass",
				reason: "Inspected",
				humanAttested: true,
			}),
			authority(),
		) as { id: string };
		c.state.promotions.push({ id: "promotion", proposalId: p.id, from: base, to: head, actor: human, at: 100, state: "complete" });
		const expected = [s.id, "source", p.id, verification.id, "promotion"];
		for (const subject of [s.id, "source", "promotion"])
			expect(c.trace(subject).map(({ record }) => record.id)).toEqual(expect.arrayContaining(expected));
	});
});
describe("public errors", () => {
	it("passes authored domain messages, names invalid fields and hides unexpected internals", () => {
		expect(publicError(new DomainError(409, "Workspace has ended"))).toEqual({ status: 409, message: "Workspace has ended" });
		const invalid = CommandInput.safeParse({ tool: "start_workspace", baseRevision: "not-a-sha" });
		expect(invalid.success).toBe(false);
		expect(publicError(invalid.error)).toEqual({ status: 400, message: expect.stringMatching(/^Invalid baseRevision: /) });
		expect(publicError(new Error("Cloudflare API /accounts/0123/artifacts: token secret"))).toEqual({
			status: 500,
			message: "Operation unavailable; retry with the same operation identity",
		});
	});
});
