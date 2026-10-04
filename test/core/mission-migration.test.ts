import { describe, expect, it } from "vitest";
import { migratePlanRecords } from "../../src/core/migrate-records.ts";
import { initialPlatform, migratePlatform, PlatformController } from "../../src/core/platform.ts";
import { type Actor, PlatformCommandInput, type PlatformState } from "../../src/shared/platform.ts";

const agent: Actor = { developerId: "developer", tenantId: "tenant", projectIds: ["project"], kind: "agent", canWrite: true };
const command = (key: string, fields: Record<string, unknown> = {}) =>
	PlatformCommandInput.parse({
		tool: "create_mission",
		projectId: "project",
		idempotencyKey: key,
		plan: { summary: "Add retries", objective: "Preserve idempotency during retries", writeSet: [] },
		...fields,
	});

describe("missions registered directly by local agents", () => {
	it("keeps the objective and background on the mission without a parent record", () => {
		const c = new PlatformController(initialPlatform(), 100);
		const m = c.execute(command("mission", { context: "Requested in the developer's local session" }), agent, "base");
		expect(m).toMatchObject({
			context: "Requested in the developer's local session",
			plan: { objective: "Preserve idempotency during retries" },
		});
		expect(c.state).not.toHaveProperty("intents");
		expect(m).not.toHaveProperty("intentId");
		expect(c.state.missions).toHaveLength(1);
		expect(() => c.execute(command("missing", { plan: undefined }), agent, "base")).toThrow("Bounded mission plan required");
	});
	it("connects alternative approaches to their original mission and rejects unknown parents before mutation", () => {
		const c = new PlatformController(initialPlatform(), 100);
		c.execute(command("original"), agent, "base");
		const original = c.state.missions[0];
		c.execute(command("alternative", { experimentOf: original.id }), agent, "base");
		const alternative = c.state.missions[1];
		c.execute(command("third", { experimentOf: alternative.id }), agent, "base");
		expect(c.state.missions[2].experimentOf).toBe(original.id);
		expect(c.trace(alternative.id).missions.map((m) => m.id)).toEqual(c.state.missions.map((m) => m.id));
		const before = structuredClone(c.state);
		expect(() => c.execute(command("unknown", { experimentOf: "missing" }), agent, "base")).toThrow("Mission unavailable");
		expect(c.state).toEqual(before);
	});
	it("rejects retired creation commands and parent references in new requests", () => {
		expect(() => PlatformCommandInput.parse({ tool: "create_intent", projectId: "project" })).toThrow();
		expect(() => command("old-parent", { intentId: "IN-1" })).toThrow();
	});
});

describe("persisted record migration", () => {
	it("preserves mission context, revision anchors and audit history while retiring parent records", () => {
		const stored = {
			...initialPlatform(),
			intents: [{ id: "IN-1", title: "Reliable payments", context: "Keep public behavior", why: "Avoid duplicate charges" }],
			missions: [
				{
					id: "M-1",
					version: 1,
					intentId: "IN-1",
					title: "Retry",
					specialization: "implementation",
					state: "active",
					at: 1,
					baseRevision: "a".repeat(40),
					headRevision: "b".repeat(40),
					plan: { summary: "Retry", intent: "Preserve idempotency", writeSet: [] },
				},
			],
			artifacts: [
				{
					id: "A-1",
					missionId: "M-1",
					intentId: "IN-1",
					revision: "b".repeat(40),
					contentHash: "unchanged",
					execution: { location: "local", detail: "agent" },
				},
			],
			timeline: [
				{ id: "E-1", at: 1, actor: "human", kind: "intent", ids: ["IN-1"], summary: "Reliable payments" },
				{ id: "E-2", at: 2, actor: "agent", kind: "mission", ids: ["IN-1", "M-1"], summary: "Retry" },
			],
			replays: { retired: { request: JSON.stringify({ tool: "create_intent" }), result: { id: "IN-1" } } },
		};
		const before = structuredClone(stored);
		const migrated = migratePlatform(stored as unknown as PlatformState);
		expect(migrated.missions[0]).toMatchObject({
			context: "Reliable payments\n\nKeep public behavior\n\nAvoid duplicate charges",
			plan: { objective: "Preserve idempotency" },
			baseRevision: "a".repeat(40),
			headRevision: "b".repeat(40),
		});
		expect(migrated.artifacts[0]).toMatchObject({ revision: "b".repeat(40), contentHash: "unchanged" });
		expect(migrated.timeline).toEqual([
			{ ...stored.timeline[0], kind: "mission_context", ids: ["M-1"] },
			{ ...stored.timeline[1], ids: ["M-1"] },
		]);
		expect(migrated).not.toHaveProperty("intents");
		expect(migrated.missions[0]).not.toHaveProperty("intentId");
		expect(migrated.artifacts[0]).not.toHaveProperty("intentId");
		expect(migrated.replays).toEqual({});
		expect(migratePlatform(migrated)).toEqual(migrated);
		expect(stored).toEqual(before);
	});
	it("upgrades stored plans, sessions and coordination receipts without changing scope or revision", () => {
		const migrated = migratePlanRecords({
			project: { capabilities: ["git_observation", "intent_mcp"] },
			plans: [{ intent: "Retry safely", baseline: "base", writeSet: [{ type: "file", resource: "src/pay.ts" }] }],
			sessions: [{ workspace: { capabilities: ["intent_mcp"], head: "head" } }],
			audit: [{ command: "update_intent" }],
			replay: { result: { coverage: { intent: true, capabilities: ["intent_mcp"] } } },
		});
		expect(migrated).toEqual({
			project: { capabilities: ["git_observation", "coordination_mcp"] },
			plans: [{ objective: "Retry safely", baseline: "base", writeSet: [{ type: "file", resource: "src/pay.ts" }] }],
			sessions: [{ workspace: { capabilities: ["coordination_mcp"], head: "head" } }],
			audit: [{ command: "update_plan" }],
			replay: { result: { coverage: { objective: true, capabilities: ["coordination_mcp"] } } },
		});
	});
});
