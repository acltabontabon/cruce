import { describe, expect, it } from "vitest";
import { decide, initialCoordination, SESSION_TTL, semanticFingerprint, WorkstreamController } from "../../src/core/workstreams.ts";
import { buildIndex } from "../../src/intelligence/structural-index.ts";
import {
	type Command,
	CommandInput,
	type CoordinationState,
	type Decision,
	type Principal,
	type ProjectConnection,
	projectKey,
} from "../../src/shared/coordination.ts";

const files = {
	"src/payment/service.ts": "export class PaymentService {\n execute(id: string) { return id; }\n}\n",
	"src/payment/response.ts": "export interface PaymentResponse { id: string }\n",
	"other.py": "def retry(): pass\n",
};
const repository: ProjectConnection = {
	id: projectKey("tenant", "123"),
	tenantId: "tenant",
	artifactRepository: "project-payments",
	name: "team/payments",
	active: true,
	version: 1,
	canonicalHead: "base",
	capabilities: ["git_observation"],
	policy: { mode: "observation", semantic: "advisory" },
};
const principal: Principal = { developerId: "human", tenantId: "tenant", projectIds: [repository.id], maintainer: true };
const plan = (summary: string, writes: string[], reads: string[] = []) => ({
	summary,
	intent: summary,
	writeSet: writes.map((resource) => ({ type: "symbol" as const, resource })),
	readSet: reads.map((resource) => ({ type: "symbol" as const, resource })),
	contractSet: summary === "Retry core" ? [{ resource: "PaymentService.execute", change: "signature" as const }] : [],
	dependencies: [],
	assumptions: [],
	risk: "medium" as const,
});
function register(
	s: CoordinationState,
	name = "Retry core",
	writes = ["PaymentService.execute"],
	instance = name,
	checkoutId = instance,
	now = 10,
) {
	const c = new WorkstreamController(s, now),
		cmd = CommandInput.parse({
			tool: "register_intent",
			projectId: s.project.id,
			idempotencyKey: name,
			plan: plan(name, writes),
			workspace: {
				id: instance,
				checkoutId,
				branch: instance,
				base: "base",
				head: "base",
				isolation: "isolated",
				precision: "symbols",
				capabilities: ["intent_mcp"],
			},
			agent: { tool: "codex", instance, role: "writer" },
		});
	const result = c.execute(cmd, principal) as Decision & { sessionId: string };
	return { c, result, cmd };
}
const fresh = () => initialCoordination(repository, buildIndex(files, "base"));
function mutation(s: CoordinationState, d: Decision & { sessionId?: string }, tool: Command["tool"], extra: Partial<Command> = {}) {
	const w = s.workstreams.find((w) => w.id === d.workstreamId)!;
	return CommandInput.parse({
		projectId: repository.id,
		tool,
		idempotencyKey: `${tool}:${s.counter}:${s.revision}`,
		workstreamId: w.id,
		sessionId: d.sessionId,
		expectedVersion: w.version,
		expectedPlanVersion: w.plans.length,
		...extra,
	});
}
describe("repository coordination", () => {
	it("replays registration exactly and rejects key reuse", () => {
		const { c, result, cmd } = register(fresh());
		expect(c.execute(cmd, principal)).toEqual(result);
		expect(c.state.workstreams).toHaveLength(1);
		expect(() => c.execute({ ...cmd, detail: "changed" }, principal)).toThrow("Idempotency");
	});
	it("separates tenant and repository authorization, and rejects removed installations", () => {
		const { cmd } = register(fresh());
		for (const p of [
			{ ...principal, tenantId: "other" },
			{ ...principal, projectIds: [] },
		])
			expect(() => new WorkstreamController(fresh(), 10).execute(cmd, p)).toThrow("access denied");
		const s = fresh();
		s.project.active = false;
		expect(() => new WorkstreamController(s, 10).execute(cmd, principal)).toThrow("access denied");
	});
	it("keeps authority stable after a rename", () => {
		expect(projectKey("tenant", "123")).toBe(repository.id);
		const s = fresh();
		s.project.name = "team/renamed";
		expect(register(s).c.state.project.id).toBe(repository.id);
		expect(projectKey("other", "123")).not.toBe(repository.id);
	});
	it("gives partial clearance while constraining publication", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentService.execute", "PaymentResponse"]);
		const d = decide(b.c.state, b.result.workstreamId, 10);
		expect(d.cleared).toContain("s:src/payment/response.ts#PaymentResponse");
		expect(d.working).toBe("PROCEED_WITH_CONSTRAINTS");
		expect(d.publication).toBe("WAIT");
		expect(d.constrained.some((c) => c.boundary === "publication")).toBe(true);
	});
	it("detects shared physical checkouts even for independent scope", () => {
		const a = register(fresh(), "Retry core", ["PaymentService.execute"], "a", "same"),
			b = register(a.c.state, "Retry API", ["PaymentResponse"], "b", "same");
		expect(decide(b.c.state, b.result.workstreamId, 10).working).toBe("WAIT");
	});
	it("expires execution reservations without deleting a workstream or publication", () => {
		const a = register(fresh());
		a.c.state.workstreams[0].publications.push({
			head: "candidate",
			base: "base",
			verified: true,
			integrated: false,
			observationId: "o",
			resources: [],
		});
		const c = new WorkstreamController(a.c.state, 10 + SESSION_TTL + 1);
		expect(decide(c.state, a.result.workstreamId, c.now).working).toBe("WAIT");
		expect(c.state.workstreams[0].publications).toHaveLength(1);
		expect(c.state.workstreams[0].state).toBe("active");
	});
	it("rejects competing writers and permits a different tool after expiry", () => {
		const a = register(fresh());
		const cmd = mutation(a.c.state, a.result, "attach_workstream", {
			workspace: a.cmd.workspace,
			agent: { tool: "claude", instance: "b", role: "writer" },
		});
		expect(() => a.c.execute(cmd, principal)).toThrow("writer is already");
		const c = new WorkstreamController(a.c.state, SESSION_TTL + 11),
			d = c.execute(cmd, principal) as Decision;
		expect(d.workstreamId).toBe(a.result.workstreamId);
		expect(c.state.workstreams[0].plans).toHaveLength(1);
		expect(c.state.sessions.map((s) => s.tool)).toEqual(["codex", "claude"]);
	});
	it("checks workstream versions without coupling amendments to unrelated liveness", () => {
		const a = register(fresh()),
			cmd = mutation(a.c.state, a.result, "update_intent", { plan: plan("Retry core", ["PaymentService.execute"]) });
		a.c.state.revision += 100;
		expect(a.c.execute(cmd, principal)).toMatchObject({ planVersion: 2 });
		expect(() => a.c.execute({ ...cmd, idempotencyKey: "new" }, principal)).toThrow("changed");
	});
	it("detects actual scope expansion and keeps local work permitted", () => {
		const a = register(fresh()),
			cmd = mutation(a.c.state, a.result, "report_change");
		const o = {
			id: "local",
			workstreamIds: [a.result.workstreamId],
			base: "base",
			head: "draft",
			branch: "feature",
			source: "local_git" as const,
			verified: false,
			at: 10,
			changes: [{ path: "other.py", status: "modified" as const, ranges: [{ start: 1, end: 1 }] }],
			index: a.c.state.index,
			headIndex: a.c.state.index,
			limitations: [],
		};
		const d = a.c.observe(o, principal, cmd) as Decision;
		expect(d.working).toBe("PROCEED");
		expect(d.publication).toBe("REPLAN");
		expect(d.nextAction).toBe("amend_scope");
		expect(d.instructions.some((i) => i.kind === "amend")).toBe(true);
	});
	it("does not treat completion as canonical integration", () => {
		const a = register(fresh());
		a.c.execute(mutation(a.c.state, a.result, "complete_workstream"), principal);
		expect(a.c.state.workstreams[0].state).toBe("completed");
		expect(a.c.state.project.canonicalHead).toBe("base");
	});
	it("rejects dependency cycles", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentResponse"]);
		const ca = new WorkstreamController(b.c.state, 10);
		ca.execute(
			mutation(ca.state, a.result, "update_intent", {
				plan: { ...plan("Retry core", ["PaymentService.execute"]), dependencies: [b.result.workstreamId] },
			}),
			principal,
		);
		expect(() =>
			ca.execute(
				mutation(ca.state, b.result, "update_intent", {
					plan: { ...plan("Retry API", ["PaymentResponse"]), dependencies: [a.result.workstreamId] },
				}),
				principal,
			),
		).toThrow("cycle");
	});
	it("keeps semantic constraints advisory until evaluated and rejects invalid resources", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentResponse"]),
			c = b.c;
		c.state.project.policy.semantic = "automatic";
		const constraint = {
			id: "semantic",
			capability: "dependency",
			workstreamId: b.result.workstreamId,
			dependency: a.result.workstreamId,
			resources: ["s:src/payment/response.ts#PaymentResponse"],
			evidence: ["e1"],
			probability: 0.99,
			response: "publication_dependency" as const,
			fingerprint: semanticFingerprint(c.state),
			model: "jev-1.13.0",
			automatic: false,
		};
		c.applySemantic(constraint, false);
		expect(c.state.semantic[0].automatic).toBe(false);
		c.applySemantic({ ...constraint }, true);
		expect(c.state.semantic[0].automatic).toBe(true);
		expect(decide(c.state, b.result.workstreamId, 10).publication).toBe("WAIT");
		expect(() => c.applySemantic({ ...constraint, resources: ["s:invented#symbol"] }, true)).toThrow("Unsupported");
	});
	it("rejects stale semantic results", () => {
		const a = register(fresh()),
			fingerprint = semanticFingerprint(a.c.state);
		a.c.state.project.version++;
		expect(
			a.c.applySemantic(
				{
					id: "x",
					capability: "intent",
					workstreamId: a.result.workstreamId,
					resources: ["s:src/payment/service.ts#PaymentService.execute"],
					evidence: ["e"],
					probability: 0.99,
					response: "review",
					fingerprint,
					model: "jev-1.13.0",
					automatic: false,
				},
				true,
			),
		).toBe(false);
	});
	it("records scoped overrides and invalidates them after an amendment", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentService.execute", "PaymentResponse"]),
			d = decide(b.c.state, b.result.workstreamId, 10);
		const overridden = b.c.override(
			principal,
			d.workstreamId,
			d.constrained.map((c) => c.resource),
			"Intentionally coordinated",
			d.fingerprint,
			10000,
		);
		expect(overridden.overridden).toBe(true);
		b.c.execute(
			mutation(b.c.state, b.result, "update_intent", { plan: plan("Retry API updated", ["PaymentService.execute", "PaymentResponse"]) }),
			principal,
		);
		expect(decide(b.c.state, b.result.workstreamId, 10).overridden).toBe(false);
	});
	it("does not grant project-wide scope to unresolved contract names", () => {
		const a = register(fresh(), "New component", ["UnknownComponent"]);
		expect(a.result.cleared).not.toContain("m:root");
	});
	it("bounds repeated unsuccessful adaptation while tracking receipt separately", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentService.execute", "PaymentResponse"]);
		const checked = b.c.execute(mutation(b.c.state, b.result, "check_coordination"), principal) as Decision;
		const instruction = checked.instructions[0];
		expect(instruction).toBeDefined();
		b.c.execute(mutation(b.c.state, b.result, "acknowledge_coordination", { instructionId: instruction.id }), principal);
		expect(b.c.state.workstreams.find((w) => w.id === b.result.workstreamId)!.instructions[0].responses).toHaveLength(0);
		for (let attempt = 0; attempt < 3; attempt++)
			b.c.execute(
				mutation(b.c.state, b.result, "respond_to_review", {
					instructionId: instruction.id,
					response: "cannot_progress",
					detail: "Shared contract remains occupied",
				}),
				principal,
			);
		expect(decide(b.c.state, b.result.workstreamId, 10).nextAction).toBe("human_review");
	});

	it("replays deterministic decisions", () => {
		const a = register(fresh()),
			b = register(a.c.state, "Retry API", ["PaymentService.execute", "PaymentResponse"]);
		expect(decide(structuredClone(b.c.state), b.result.workstreamId, 10)).toEqual(decide(b.c.state, b.result.workstreamId, 10));
	});
});
