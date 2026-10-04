import { describe, expect, it } from "vitest";
import {
	DEFAULT_RESOURCE_POLICY,
	evaluateResource,
	missingScope,
	normalizeResourcePolicy,
	type ResourceSubject,
	recordUsage,
} from "../../src/core/capabilities.ts";

const now = Date.UTC(2026, 9, 5, 12);
const agent = (action: ResourceSubject["action"], missionId?: string): ResourceSubject => ({ action, missionId, actorKind: "agent" });

describe("resource policy and cost awareness", () => {
	it("allows cheap Artifacts work, requires approval for cloud AI and never lets agents deploy production", () => {
		expect(evaluateResource(DEFAULT_RESOURCE_POLICY, {}, agent("revision.publish"), now)).toMatchObject({
			outcome: "allow",
			cost: "artifacts",
		});
		expect(evaluateResource(DEFAULT_RESOURCE_POLICY, {}, agent("ai.inference"), now).outcome).toBe("approval");
		const production = evaluateResource(
			{ ...DEFAULT_RESOURCE_POLICY, rules: { ...DEFAULT_RESOURCE_POLICY.rules, "production.deploy": "allow" } },
			{},
			agent("production.deploy"),
			now,
		);
		expect(production).toMatchObject({ outcome: "approval", cost: "metered_production" });
		expect(evaluateResource(DEFAULT_RESOURCE_POLICY, {}, { action: "production.deploy", actorKind: "human" }, now).outcome).toBe("allow");
	});
	it("turns exhausted preview budgets into a human approval instead of silent spend", () => {
		let usage = {};
		for (let i = 0; i < DEFAULT_RESOURCE_POLICY.budgets.previewsPerMission; i++) {
			expect(evaluateResource(DEFAULT_RESOURCE_POLICY, usage, agent("preview.deploy", "M-1"), now).outcome).toBe("allow");
			usage = recordUsage(usage, agent("preview.deploy", "M-1"), now);
		}
		const blocked = evaluateResource(DEFAULT_RESOURCE_POLICY, usage, agent("preview.deploy", "M-1"), now);
		expect(blocked).toMatchObject({ outcome: "approval", cost: "metered" });
		expect(blocked.reason).toContain("Mission preview budget");
		expect(evaluateResource(DEFAULT_RESOURCE_POLICY, usage, agent("preview.deploy", "M-2"), now).outcome).toBe("allow");
		expect(evaluateResource(DEFAULT_RESOURCE_POLICY, usage, agent("preview.deploy", "M-1"), now + 86_400_000).outcome).toBe("approval");
	});
	it("denies what policy denies, even for humans", () => {
		const policy = { ...DEFAULT_RESOURCE_POLICY, rules: { ...DEFAULT_RESOURCE_POLICY.rules, "preview.deploy": "deny" as const } };
		expect(evaluateResource(policy, {}, { action: "preview.deploy", actorKind: "human" }, now).outcome).toBe("deny");
	});
	it("normalizes maintainer policy: production stays a human decision and budgets are bounded", () => {
		const policy = normalizeResourcePolicy({
			...DEFAULT_RESOURCE_POLICY,
			rules: { ...DEFAULT_RESOURCE_POLICY.rules, "production.deploy": "allow" },
		});
		expect(policy.rules["production.deploy"]).toBe("approval");
		expect(() =>
			normalizeResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, budgets: { ...DEFAULT_RESOURCE_POLICY.budgets, previewsPerDay: -1 } }),
		).toThrow("Budget");
	});
	it("reports a missing scope in plain terms and treats humans as unscoped", () => {
		expect(missingScope(["cruce:read"], "preview:request")).toContain("preview:request");
		expect(missingScope(undefined, "preview:request")).toBeUndefined();
	});
});
