import {
	DEMO_FLIGHTS,
	DEMO_WORK,
	type DemoWorkKey,
	JWT_MIGRATION,
	overlayFiles,
	ROTATION_AMENDMENT,
	ROTATION_V1,
	ROTATION_V2,
	SESSION_CLEANUP,
} from "../demo/scenario.ts";
import type { DemoStatus } from "../shared/api.ts";
import type { Tower } from "./tower.ts";

export type { DemoStatus };

/**
 * DEMO MODE: a deterministic script of what each mock agent *attempts*, step by step.
 *
 * The script never decides anything. Flight Plans go through the same controller, diffs through the
 * same publish gate, landings through real Git merges. If a controller overrides the traffic plan
 * mid-demo, later steps simply get different (still correct) answers from the controller.
 */

export interface DemoStep {
	id: string;
	label: string;
	/** Milliseconds to wait before this step at 1× speed. */
	delay: number;
	run(t: Tower): Promise<void>;
}

const activity = (t: Tower, items: Record<string, string>) =>
	t.mutate((c) => {
		for (const [id, text] of Object.entries(items)) {
			if (c.state.flights.some((f) => f.id === id && !["landed", "failed", "lost", "cancelled"].includes(f.phase)))
				c.reportActivity(id, text);
		}
	});

async function work(t: Tower, flightId: string, key: DemoWorkKey, passed: string) {
	const step = DEMO_WORK[key];
	const out = await t.publish(flightId, { files: overlayFiles(step.overlay), message: step.message });
	if (out.approved) t.validate(flightId, out.commit, true, `${passed} (node --test, reported by the demo agent)`);
	return out;
}

export const DEMO_SCRIPT: DemoStep[] = [
	{
		id: "missions",
		label: "Three Missions are delegated",
		delay: 400,
		run: async (t) =>
			t.mutate((c) => {
				for (const d of DEMO_FLIGHTS) {
					const m = c.createMission({ title: d.mission.title, description: d.mission.description, priority: d.mission.priority });
					c.createFlight({ missionId: m.id, agent: "mock", agentRuntime: "demo agent (scripted)" });
				}
			}),
	},
	{
		id: "provision",
		label: "Each Flight gets its own Artifacts fork",
		delay: 1200,
		run: async (t) => void (await Promise.all(DEMO_FLIGHTS.map((d) => t.provision(d.flightId)))),
	},
	{
		id: "discovery",
		label: "Discovery: agents read before they claim airspace",
		delay: 1200,
		run: async (t) =>
			activity(t, {
				"F-021": "Reading AuthService.refreshToken and RefreshTokenRepository",
				"F-022": "Mapping every caller of TokenValidator.validate",
				"F-023": "Reading SessionService and SessionRepository",
			}),
	},
	{
		id: "plan-023",
		label: "F-023 files its Flight Plan",
		delay: 2200,
		run: async (t) => void t.mutate((c) => c.submitPlan("F-023", SESSION_CLEANUP)),
	},
	{
		id: "plan-022",
		label: "F-022 files its Flight Plan",
		delay: 2000,
		run: async (t) => void t.mutate((c) => c.submitPlan("F-022", JWT_MIGRATION)),
	},
	{
		id: "plan-021",
		label: "F-021 files its Flight Plan",
		delay: 2000,
		run: async (t) => void t.mutate((c) => c.submitPlan("F-021", ROTATION_V1)),
	},
	{
		id: "execute",
		label: "Flights execute inside their clearance",
		delay: 2600,
		run: async (t) =>
			activity(t, {
				"F-022": "Replacing the decoder; ValidationResult for TokenValidator.validate",
				"F-023": "Adding cleanupExpired() and deleteIdleSince()",
				"F-021": "Adding token families to RefreshTokenRepository",
			}),
	},
	{ id: "publish-023", label: "F-023 publishes", delay: 2600, run: async (t) => void (await work(t, "F-023", "F-023", "11 passed")) },
	{
		id: "publish-021-rejected",
		label: "F-021 tries to publish beyond its clearance",
		delay: 2400,
		run: async (t) => {
			const step = DEMO_WORK["F-021:1"];
			await t.publish("F-021", { files: overlayFiles(step.overlay), message: step.message });
		},
	},
	{
		id: "amend-021",
		label: "F-021 requests airspace: AuthService.logout",
		delay: 2000,
		run: async (t) => void t.mutate((c) => c.requestAirspace("F-021", ROTATION_AMENDMENT, "logout must revoke the whole token family")),
	},
	{
		id: "publish-021",
		label: "F-021 publishes its cleared work",
		delay: 2000,
		run: async (t) => void (await work(t, "F-021", "F-021:1", "12 passed")),
	},
	{ id: "publish-022", label: "F-022 publishes", delay: 2400, run: async (t) => void (await work(t, "F-022", "F-022", "11 passed")) },
	{ id: "land-022", label: "F-022 lands", delay: 2400, run: async (t) => void (await t.land("F-022")) },
	{ id: "land-023", label: "F-023 lands", delay: 2400, run: async (t) => void (await t.land("F-023")) },
	{
		id: "refresh-021",
		label: "Cruce refreshes F-021 onto the new baseline",
		delay: 2400,
		run: async (t) => {
			await t.refresh("F-021");
			activity(t, { "F-021": "Re-reading TokenValidator on the new baseline" });
		},
	},
	{
		id: "replan-021",
		label: "F-021 amends its Flight Plan",
		delay: 2800,
		run: async (t) => void t.mutate((c) => c.submitPlan("F-021", ROTATION_V2)),
	},
	{
		id: "publish-021b",
		label: "F-021 publishes the rotation",
		delay: 2800,
		run: async (t) => void (await work(t, "F-021", "F-021:2", "15 passed")),
	},
	{ id: "land-021", label: "F-021 lands", delay: 2400, run: async (t) => void (await t.land("F-021")) },
];

export function initialDemoStatus(): DemoStatus {
	return { next: 0, total: DEMO_SCRIPT.length, running: false, speed: 1, finished: false, nextLabel: DEMO_SCRIPT[0].label };
}

/** First useful frame: real plans and partial clearance, paused before any publishes. */
export async function prepareDemo(tower: Tower, status: DemoStatus, onProgress?: (status: DemoStatus) => void): Promise<DemoStatus> {
	let current: DemoStatus = { ...status, running: false, nextAt: undefined };
	while (current.next < 7 && !current.error) {
		current = await runNextStep(tower, current);
		onProgress?.(current);
	}
	return current;
}

/** Run the next step. Errors pause the demo and are reported; the step can be retried. */
export async function runNextStep(t: Tower, status: DemoStatus): Promise<DemoStatus> {
	const step = DEMO_SCRIPT[status.next];
	if (!step) return { ...status, running: false, finished: true, nextAt: undefined, nextLabel: undefined };
	try {
		await step.run(t);
	} catch (e) {
		return { ...status, running: false, nextAt: undefined, error: `${step.label}: ${(e as Error).message ?? e}` };
	}
	const next = status.next + 1;
	const following = DEMO_SCRIPT[next];
	return {
		...status,
		next,
		error: undefined,
		lastLabel: step.label,
		nextLabel: following?.label,
		finished: !following,
		running: status.running && !!following,
		nextAt: undefined,
	};
}

export function delayFor(status: DemoStatus): number {
	const step = DEMO_SCRIPT[status.next];
	return step ? Math.round(step.delay / Math.max(0.25, status.speed)) : 0;
}
