import { describe, expect, it } from "vitest";
import { initialPlatform, PlatformController } from "../../src/core/platform.ts";
import { type Actor, PlatformCommandInput, type Proposal, type Verification } from "../../src/shared/platform.ts";

const human: Actor = { developerId: "human", tenantId: "tenant", systemIds: ["system"], kind: "human", maintainer: true, canWrite: true },
	agent: Actor = { ...human, kind: "agent" };
const command = (tool: typeof PlatformCommandInput._output.tool, extra: Record<string, unknown> = {}) =>
	PlatformCommandInput.parse({ tool, systemId: "system", idempotencyKey: tool, ...extra });
function fixture() {
	const c = new PlatformController(initialPlatform(), 100);
	const i = c.execute(
		command("create_intent", { title: "Retry payments", context: "Preserve public behavior", why: "Reliability" }),
		human,
		"base",
	) as { id: string };
	const m = c.execute(
		command("create_mission", {
			intentId: i.id,
			plan: { summary: "Retry", intent: "Implement retry", writeSet: [{ type: "file", resource: "src/pay.ts" }] },
		}),
		agent,
		"base",
	) as { id: string };
	const a = c.artifact({
		kind: "source",
		missionId: m.id,
		intentId: i.id,
		title: "Retry source",
		summary: "Retry safely",
		revision: "head",
		parentRevision: "base",
		contentHash: "head",
		storage: { repository: "artifacts-workspace", revision: "head" },
		producer: { actor: agent.developerId, kind: "agent" },
		environment: "codex",
		related: [],
		trust: "verified",
	});
	c.artifact({ ...a, kind: "test_report", title: "Test run", trust: "reported" });
	const p = c.execute(
		command("create_proposal", { missionId: m.id, artifactId: a.id, impact: "No new service dependency" }),
		agent,
		"base",
	) as Proposal;
	return { c, i, m, a, p };
}
describe("native collaboration and promotion policy", () => {
	it("preserves intent-to-proposal lineage and immutable source references", () => {
		const { c, i, m, a, p } = fixture();
		expect(c.state.timeline.flatMap((e) => e.ids)).toEqual(expect.arrayContaining([i.id, m.id, a.id, p.id]));
		expect(p.revision).toBe(a.revision);
		expect(c.state.intents[0].why).toBe("Reliability");
	});
	it("replays exactly and rejects reused keys with changed requirements", () => {
		const c = new PlatformController(initialPlatform(), 100),
			cmd = command("create_intent", { title: "Fix", context: "Race" });
		expect(c.execute(cmd, human, "base")).toEqual(c.execute(cmd, human, "base"));
		expect(c.state.intents).toHaveLength(1);
		expect(() => c.execute({ ...cmd, context: "Different" }, human, "base")).toThrow("Idempotency");
	});
	it("does not treat reported agent tests or agent approval as promotion authority", () => {
		const { c, p } = fixture();
		c.execute(
			command("attach_verification", {
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
		expect(() => c.preparePromotion(command("promote_proposal", { proposalId: p.id, expectedVersion: p.version }), agent, "base")).toThrow(
			"agents cannot promote",
		);
	});
	it("pins evidence and approvals to source and policy revisions", () => {
		const { c, p } = fixture();
		c.execute(
			command("attach_verification", {
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
				command("attach_verification", {
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
		expect(() => PlatformCommandInput.parse({ tool: "publish_artifact", systemId: "system", trust: "verified" })).toThrow();
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
			command("attach_verification", {
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
				command("attach_verification", { proposalId: p.id, expectedVersion: p.version, verificationKind: "tests", outcome: "pass" }),
				human,
				"base",
			),
		).toThrow("evidence artifacts");
		const base = { proposalId: p.id, verificationKind: "tests", related: [c.state.artifacts.find((a) => a.kind === "test_report")!.id] };
		c.execute(
			command("attach_verification", { ...base, expectedVersion: p.version, outcome: "pass", idempotencyKey: "pass" }),
			human,
			"base",
		);
		c.execute(
			command("attach_verification", { ...base, expectedVersion: p.version, outcome: "fail", idempotencyKey: "fail" }),
			human,
			"base",
		);
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
