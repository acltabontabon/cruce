import { describe, expect, it } from "vitest";
import { initialPlatform, PlatformController } from "../../src/core/platform.ts";
import { type Actor, PlatformCommandInput, type Proposal, type Verification } from "../../src/shared/platform.ts";

const human: Actor = { developerId: "human", tenantId: "tenant", projectIds: ["project"], kind: "human", maintainer: true, canWrite: true },
	agent: Actor = { ...human, kind: "agent" };
const command = (tool: typeof PlatformCommandInput._output.tool, extra: Record<string, unknown> = {}) =>
	PlatformCommandInput.parse({ tool, projectId: "project", idempotencyKey: tool, ...extra });
function fixture() {
	const c = new PlatformController(initialPlatform(), 100);

	const m = c.execute(
		command("create_mission", {
			plan: { summary: "Retry", objective: "Implement retry", writeSet: [{ type: "file", resource: "src/pay.ts" }] },
		}),
		agent,
		"base",
	) as { id: string };
	const a = c.artifact({
		kind: "source",
		missionId: m.id,
		title: "Retry source",
		summary: "Retry safely",
		revision: "head",
		parentRevision: "base",
		contentHash: "head",
		storage: { repository: "artifacts-workspace", revision: "head" },
		producer: { actor: agent.developerId, kind: "agent" },
		execution: { location: "local", detail: "codex" },
		related: [],
		trust: "verified",
	});
	c.artifact({ ...a, kind: "test_report", title: "Test run", trust: "reported" });
	const p = c.execute(
		command("create_proposal", { missionId: m.id, artifactId: a.id, impact: "No new service dependency" }),
		agent,
		"base",
	) as Proposal;
	return { c, m, a, p };
}
describe("native collaboration and promotion policy", () => {
	it("preserves objective-to-proposal lineage and immutable source references", () => {
		const { c, m, a, p } = fixture();
		expect(c.state.timeline.flatMap((e) => e.ids)).toEqual(expect.arrayContaining([m.id, a.id, p.id]));
		expect(p.revision).toBe(a.revision);
		expect(c.state.missions[0].plan.objective).toBe("Implement retry");
	});
	it("replays exactly and rejects reused keys with changed requirements", () => {
		const c = new PlatformController(initialPlatform(), 100),
			cmd = command("create_mission", { plan: { summary: "Fix", objective: "Resolve race", writeSet: [] }, context: "Race" });
		expect(c.execute(cmd, human, "base")).toEqual(c.execute(cmd, human, "base"));
		expect(c.state.missions).toHaveLength(1);
		expect(() => c.execute({ ...cmd, context: "Different" }, human, "base")).toThrow("Idempotency");
	});
	it("does not treat reported agent tests or agent approval as promotion authority", () => {
		const { c, p } = fixture();
		c.execute(
			command("attach_evidence", {
				proposalId: p.id,
				expectedVersion: p.version,
				verificationKind: "tests",
				related: [c.state.artifacts.find((a) => a.kind === "test_report")!.id],
				outcome: "pass",
				summary: "Tests passed",
			}),
			agent,
			"base",
		);
		c.execute(
			command("review_proposal", { proposalId: p.id, expectedVersion: p.version, outcome: "approve", summary: "Agent review" }),
			agent,
			"base",
		);
		expect(c.readiness(p.id, "base").reasons.join(" ")).toContain("Trusted tests");
		expect(c.readiness(p.id, "base").reasons).toContain("Human approval required");
		expect(() =>
			c.preparePromotion(command("promote_proposal", { proposalId: p.id, expectedVersion: p.version }), agent, "base", "repo"),
		).toThrow("agents cannot promote");
	});
	it("pins evidence and approvals to source and policy revisions", () => {
		const { c, p } = fixture();
		c.execute(
			command("attach_evidence", {
				proposalId: p.id,
				expectedVersion: p.version,
				verificationKind: "tests",
				related: [c.state.artifacts.find((a) => a.kind === "test_report")!.id],
				outcome: "pass",
				summary: "Inspected test run",
			}),
			human,
			"base",
		);
		c.execute(
			command("review_proposal", {
				proposalId: p.id,
				expectedVersion: p.version,
				outcome: "approve",
				summary: "Reviewed source and evidence",
			}),
			human,
			"base",
		);
		expect(c.readiness(p.id, "base").outcome).toBe("READY");
		expect(c.readiness(p.id, "new").outcome).toBe("REFRESH");
		c.state.policy.version++;
		expect(c.readiness(p.id, "base").reasons).toContain("Human approval required");
	});
	it("preserves agent disagreement and records its human resolution", () => {
		const { c, p } = fixture();
		const r = c.execute(
			command("review_proposal", {
				proposalId: p.id,
				expectedVersion: p.version,
				outcome: "disagree",
				summary: "Synchronous dependency adds latency",
			}),
			agent,
			"base",
		) as { id: string };
		expect(c.readiness(p.id, "base").outcome).toBe("NEEDS_ATTENTION");
		expect(() =>
			c.execute(
				command("resolve_review", { proposalId: p.id, expectedVersion: p.version, reviewId: r.id, reason: "Decision" }),
				agent,
				"base",
			),
		).toThrow("Human maintainer");
		c.execute(
			command("resolve_review", { proposalId: p.id, expectedVersion: p.version, reviewId: r.id, reason: "Use the existing queue" }),
			human,
			"base",
		);
		expect(c.state.reviews[0].summary).toContain("latency");
		expect(c.state.reviews[0].resolved?.reason).toBe("Use the existing queue");
	});
	it("rejects forged artifact ownership and wrong-revision evidence", () => {
		const { c, p, m } = fixture();
		expect(() =>
			c.execute(command("create_proposal", { missionId: m.id, artifactId: "fake", idempotencyKey: "forged" }), agent, "base"),
		).toThrow("Verified source");
		expect(() =>
			c.execute(
				command("attach_evidence", {
					proposalId: p.id,
					expectedVersion: p.version,
					verificationKind: "tests",
					outcome: "pass",
					related: ["fake"],
				}),
				agent,
				"base",
			),
		).toThrow("exact source revision");
		expect(() => PlatformCommandInput.parse({ tool: "publish_artifact", projectId: "project", trust: "verified" })).toThrow();
	});
	it("holds failed verification even when another report says pass", () => {
		const { c, p } = fixture();
		c.state.verifications.push({
			id: "failed",
			proposalId: p.id,
			revision: p.revision,
			kind: "tests",
			outcome: "fail",
			artifactIds: [],
			summary: "Regression",
			actor: "security",
			trust: "runtime_verified",
			at: 100,
		} satisfies Verification);
		c.execute(
			command("attach_evidence", {
				proposalId: p.id,
				expectedVersion: p.version,
				verificationKind: "tests",
				related: [c.state.artifacts.find((a) => a.kind === "test_report")!.id],
				outcome: "pass",
			}),
			human,
			"base",
		);
		expect(c.readiness(p.id, "base").outcome).toBe("NEEDS_ATTENTION");
	});
	it("requires evidence references and keeps same-clock later failures authoritative", () => {
		const { c, p } = fixture();
		expect(() =>
			c.execute(
				command("attach_evidence", { proposalId: p.id, expectedVersion: p.version, verificationKind: "tests", outcome: "pass" }),
				human,
				"base",
			),
		).toThrow("evidence artifacts");
		const base = { proposalId: p.id, verificationKind: "tests", related: [c.state.artifacts.find((a) => a.kind === "test_report")!.id] };
		c.execute(command("attach_evidence", { ...base, expectedVersion: p.version, outcome: "pass", idempotencyKey: "pass" }), human, "base");
		c.execute(command("attach_evidence", { ...base, expectedVersion: p.version, outcome: "fail", idempotencyKey: "fail" }), human, "base");
		expect(c.readiness(p.id, "base").outcome).toBe("NEEDS_ATTENTION");
		expect(c.readiness(p.id, "base").evidence).toHaveLength(1);
	});
	it("only allows versioned human policy changes and invalidates old approvals", () => {
		const { c, p } = fixture(),
			cmd = command("set_policy", {
				expectedVersion: 1,
				reason: "Security requires another approval",
				policy: { approvals: 2, requiredEvidence: ["tests", "security"] },
			});
		expect(() => c.execute(cmd, agent, "base")).toThrow("Human maintainer");
		c.execute(cmd, human, "base");
		expect(c.state.policy.agentPromotion).toBe(false);
		expect(c.readiness(p.id, "base").reasons).toContain("Policy changed; re-evaluate this proposal");
		expect(() => c.execute({ ...cmd, idempotencyKey: "stale" }, human, "base")).toThrow("Policy changed");
	});

	it("replays deterministically with injected time", () => {
		expect(fixture().c.state).toEqual(fixture().c.state);
	});
});

describe("proposal lifecycle, resources and lineage", () => {
	const testReport = (c: PlatformController) => c.state.artifacts.find((a) => a.kind === "test_report")!.id;
	it("records human rejection and change requests as closed decisions", () => {
		const { c, p } = fixture();
		expect(() =>
			c.execute(
				command("decide_proposal", { proposalId: p.id, expectedVersion: p.version, decision: "reject", reason: "No" }),
				agent,
				"base",
			),
		).toThrow("Human maintainer");
		c.execute(
			command("decide_proposal", { proposalId: p.id, expectedVersion: p.version, decision: "request_changes", reason: "Cover retries" }),
			human,
			"base",
		);
		expect(c.readiness(p.id, "base")).toMatchObject({ outcome: "CLOSED" });
		expect(c.readiness(p.id, "base").reasons[0]).toContain("Cover retries");
		expect(() =>
			c.execute(
				command("review_proposal", { proposalId: p.id, expectedVersion: c.proposal(p.id).version, outcome: "approve", summary: "late" }),
				human,
				"base",
			),
		).toThrow("changes requested");
	});
	it("supersedes the open proposal when a mission proposes a newer revision", () => {
		const { c, m, a, p } = fixture();
		const next = c.artifact({ ...a, revision: "head2", contentHash: "head2", storage: { ...a.storage, revision: "head2" } });
		const p2 = c.execute(
			command("create_proposal", { missionId: m.id, artifactId: next.id, idempotencyKey: "second" }),
			agent,
			"base",
		) as Proposal;
		expect(p2.number).toBe(2);
		expect(c.proposal(p.id)).toMatchObject({ state: "superseded", supersededBy: p2.id });
	});
	it("pins verification requests to the exact revision and reports what is missing", () => {
		const { c, p } = fixture();
		const out = c.execute(
			command("request_verification", { proposalId: p.id, expectedVersion: p.version, verificationKinds: ["tests", "security"] }),
			agent,
			"base",
		) as {
			request: { revision: string; kinds: string[] };
			readiness: { missing: string[] };
		};
		expect(out.request).toMatchObject({ revision: "head", kinds: ["tests", "security"] });
		expect(out.readiness.missing).toEqual(["tests"]);
	});
	it("lets agents request promotion but answers that a human must decide", () => {
		const { c, p } = fixture();
		const out = c.execute(command("request_promotion", { proposalId: p.id, expectedVersion: p.version }), agent, "base") as {
			decision: string;
		};
		expect(out.decision).toContain("Human approval required");
		expect(c.proposal(p.id).promotionRequestedAt).toBe(100);
	});
	it("gates resource actions: pending approval, human decision, then exactly one execution", () => {
		const { c, m } = fixture();
		c.state.policy.resources.rules["workspace.create"] = "approval";
		const pending = c.gate("workspace.create", agent, { missionId: m.id, revision: "base" });
		expect(pending).toMatchObject({ state: "pending", cost: "artifacts" });
		expect(c.gate("workspace.create", agent, { missionId: m.id, revision: "base" })?.id).toBe(pending!.id);
		expect(() =>
			c.decideResourceRequest(command("decide_resource_request", { requestId: pending!.id, decision: "approve", reason: "ok" }), agent),
		).toThrow("Human");
		c.decideResourceRequest(
			command("decide_resource_request", { requestId: pending!.id, decision: "approve", reason: "Bounded experiment" }),
			human,
		);
		expect(c.gate("workspace.create", agent, { missionId: m.id, revision: "base" })).toBeUndefined();
		expect(c.state.resourceRequests[0].state).toBe("executed");
		expect(c.gate("workspace.create", agent, { missionId: m.id, revision: "base" })?.state).toBe("pending");
	});
	it("treats Cruce's own deployment checks as runtime-verified evidence and traces production back to objective", () => {
		const { c, m, p } = fixture();
		const env = c.addEnvironment(
			{
				name: "Worker Preview",
				kind: "preview",
				target: { type: "external", description: "fixture" },
				smokeChecks: [{ path: "/", expectStatus: 200 }],
				createdBy: "human",
			},
			human,
		);
		const d = c.recordDeployment({ environmentId: env.id, revision: "head", proposalId: p.id, actor: "agent" }, agent);
		c.updateDeployment(d.id, { state: "deployed", url: "https://preview.example" });
		const report = c.artifact({
			...c.state.artifacts[1],
			kind: "preview_report",
			trust: "verified",
			producer: { actor: "cruce-runtime", kind: "runtime" },
		});
		const v = c.runtimeVerification(c.deployment(d.id), "tests", "pass", "smoke", [report.id]);
		expect(v?.trust).toBe("runtime_verified");
		expect(c.readiness(p.id, "base").missing).toEqual([]);
		const trace = c.trace(d.id);
		expect(trace.missions.map((x) => x.id)).toEqual([m.id]);
		expect(trace.proposals.map((x) => x.id)).toEqual([p.id]);
		expect(trace.revisions).toContain("head");
		expect(c.trace(m.id).deployments.map((x) => x.id)).toEqual([d.id]);
		expect(testReport(c)).toBeDefined();
	});
});
