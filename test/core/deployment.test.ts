import { describe, expect, it } from "vitest";
import { detectDeploymentProfile, explainRollback, liveDeployment, previewBranch } from "../../src/core/deployment.ts";
import { initialPlatform } from "../../src/core/platform.ts";
import type { PlatformState } from "../../src/shared/platform.ts";

describe("deployment knowledge", () => {
	it("detects Cloudflare Workers from Wrangler or cf configuration and keeps other applications first-class", () => {
		expect(detectDeploymentProfile({ "wrangler.jsonc": '{\n  // api\n  "name": "customer-api"\n}' }, "r1")).toEqual({
			kind: "cloudflare_worker",
			configPath: "wrangler.jsonc",
			workerName: "customer-api",
			revision: "r1",
		});
		expect(detectDeploymentProfile({ "wrangler.toml": 'name = "payments"\nmain = "src/index.ts"' }, "r2")).toMatchObject({
			workerName: "payments",
		});
		expect(detectDeploymentProfile({ "cloudflare.config.ts": 'worker: { name: "cruce" }' }, "r3")).toMatchObject({ workerName: "cruce" });
		expect(detectDeploymentProfile({ "build.gradle": "plugins {}", Dockerfile: "FROM eclipse-temurin" }, "r4")).toEqual({
			kind: "unknown",
			revision: "r4",
		});
	});
	it("names one preview branch per proposal", () => {
		expect(previewBranch({ number: 84 })).toBe("cruce/proposal-84");
	});
	it("explains a rollback as the promoted proposals it removes", () => {
		const s: PlatformState = {
			...initialPlatform(),
			intents: [{ id: "IN-1", version: 1, title: "Protect Customer API", context: "", why: "", owner: "h", at: 1 }],
			missions: [
				{
					id: "M-1",
					version: 1,
					intentId: "IN-1",
					title: "Implement rate limiting",
					specialization: "implementation",
					plan: {} as never,
					state: "completed",
					at: 1,
				},
			],
			proposals: [
				{
					id: "P-1",
					number: 84,
					version: 1,
					missionId: "M-1",
					artifactId: "A-1",
					summary: "Add rate limiting",
					impact: "",
					risks: [],
					questions: [],
					risk: "low",
					base: "old",
					revision: "new",
					repository: "r",
					commits: 1,
					files: 2,
					policyVersion: 1,
					state: "promoted",
					at: 1,
				},
			],
			promotions: [
				{
					id: "PM-1",
					proposalId: "P-1",
					from: "old",
					to: "new",
					repository: "r",
					actor: "h",
					proposalVersion: 1,
					policyVersion: 1,
					evidenceIds: [],
					reviewIds: [],
					state: "complete",
					at: 1,
				},
			],
			verifications: [
				{
					id: "V-1",
					proposalId: "P-0",
					revision: "old",
					kind: "tests",
					outcome: "pass",
					artifactIds: [],
					summary: "",
					actor: "h",
					trust: "human_attested",
					at: 1,
				},
			],
		};
		expect(explainRollback(s, "new", "old", ["new", "old"])).toEqual({
			removes: [
				{ proposalId: "P-1", number: 84, summary: "Add rate limiting", mission: "Implement rate limiting", intent: "Protect Customer API" },
			],
			targetVerified: true,
		});
		expect(() => explainRollback(s, "old", "new", ["new", "old"])).toThrow("earlier accepted revision");
	});
	it("knows which revision is live in an environment", () => {
		const d = (id: string, state: "deployed" | "superseded", updatedAt: number) => ({
			id,
			environmentId: "ENV-1",
			revision: id,
			state,
			evidenceIds: [],
			actor: "h",
			at: 1,
			updatedAt,
		});
		expect(liveDeployment({ deployments: [d("a", "superseded", 1), d("b", "deployed", 2)] }, "ENV-1")?.revision).toBe("b");
	});
});
