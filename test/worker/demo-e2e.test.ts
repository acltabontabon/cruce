import { describe, expect, it } from "vitest";
import type { ControllerState, TowerEvent } from "../../src/core/controller.ts";
import type { ProjectInfo } from "../../src/core/domain.ts";
import { overlayFiles } from "../../src/demo/scenario.ts";
import { DEMO_SCRIPT, initialDemoStatus, runNextStep } from "../../src/worker/demo-director.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { CANONICAL, ProjectGit } from "../../src/worker/project-git.ts";
import { Tower, type TowerStore } from "../../src/worker/tower.ts";

const project: ProjectInfo = {
	id: "demo",
	name: "auth-service",
	repo: "auth-service",
	namespace: "local",
	defaultBranch: "main",
	mode: "demo",
	gitBackend: "simulated",
};

function memoryStore(): TowerStore & { events: TowerEvent[] } {
	const kv = new Map<string, unknown>();
	const events: TowerEvent[] = [];
	return {
		events,
		get: <T>(k: string) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined) as T | undefined,
		put: (k, v) => kv.set(k, structuredClone(v)),
		delete: (k) => kv.delete(k),
		appendEvents: (e) => events.push(...e),
	};
}

async function newTower() {
	const git = new ProjectGit(new GitWorkspace(new MemoryFs() as never), "auth-service");
	const store = memoryStore();
	const snapshots: ControllerState[] = [];
	let t = 1_000;
	const tower = new Tower(project, git, store, { onChange: (s) => snapshots.push(s) }, () => (t += 500), 21);
	await tower.bootstrap();
	return { tower, git, store, snapshots };
}

async function runTo(tower: Tower, stepId: string, status = initialDemoStatus()) {
	let s = status;
	while (DEMO_SCRIPT[s.next] && DEMO_SCRIPT[s.next - 1]?.id !== stepId) {
		s = await runNextStep(tower, s);
		if (s.error) throw new Error(s.error);
	}
	return s;
}

describe("demo mode end to end (controller + real Git)", () => {
	it("tells the whole story", async () => {
		const { tower, git, store } = await newTower();
		const status = (id: string) => tower.state.traffic.clearances[id]?.status;

		let s = await runTo(tower, "plan-023");
		expect(tower.state.flights.map((f) => f.artifact?.repo)).toEqual(["auth-service--f021", "auth-service--f022", "auth-service--f023"]);
		expect(status("F-023")).toBe("clear");

		s = await runTo(tower, "plan-021", s);
		expect(status("F-022")).toBe("clear");
		expect(status("F-021")).toBe("partial");
		expect(tower.state.traffic.clearances["F-021"].held[0].resource).toContain("TokenValidator.validate");

		s = await runTo(tower, "publish-021-rejected", s);
		expect(tower.flight("F-021").publishes.at(-1)?.approved).toBe(false);
		s = await runTo(tower, "publish-021", s);
		expect(tower.flight("F-021").publishes.at(-1)?.approved).toBe(true);
		expect(status("F-021")).toBe("partial");

		s = await runTo(tower, "land-022", s);
		expect(tower.flight("F-022").phase).toBe("landed");
		expect(tower.flight("F-021").stale?.byFlight).toBe("F-022");

		s = await runTo(tower, "land-023", s);
		expect(tower.flight("F-023").phase).toBe("landed");

		s = await runTo(tower, "replan-021", s);
		expect(tower.flight("F-021").plan?.planVersion).toBe(3);
		expect(status("F-021")).toBe("clear");

		s = await runTo(tower, "land-021", s);
		expect(s.finished).toBe(true);
		expect(tower.state.flights.map((f) => f.phase)).toEqual(["landed", "landed", "landed"]);

		// Git is the source of truth: canonical contains every Flight's work, merged for real.
		const files = await git.filesAt(CANONICAL);
		expect(files["src/auth/auth-service.ts"]).toBe(overlayFiles("f021-rotation-2")["src/auth/auth-service.ts"]);
		expect(files["src/sessions/session-service.ts"]).toContain("cleanupExpired");
		expect(files["src/auth/token-validator.ts"]).toContain("ValidationResult");

		const history = await git.history(CANONICAL, 20);
		const landings = history.filter((h) => h.message.startsWith("Land "));
		expect(landings.map((h) => h.message)).toEqual([
			"Land F-021: Refresh-token rotation",
			"Land F-023: Session cleanup",
			"Land F-022: JWT library migration",
		]);
		const note = landings[0].note as { flightId: string; planAmendments: unknown[]; congestion: { with: string }[] };
		expect(note.flightId).toBe("F-021");
		expect(note.planAmendments.length).toBe(2);
		expect(note.congestion[0]?.with).toBeUndefined(); // F-022 already landed: no live congestion at landing

		const types = store.events.map((e) => e.type);
		expect(types.filter((x) => x === "flight.landed")).toHaveLength(3);
		expect(types).toContain("publish.rejected");
		expect(types).toContain("flight.stale");
		expect(types).toContain("baseline.refreshed");
		expect(tower.state.canonical.head).toBe(history[0].oid);
		for (const flight of tower.state.flights) {
			expect(flight.finishedAt).toBe(flight.landedAt);
			expect(flight.cleanup?.status).toBe("complete");
			expect(await git.resolve(`refs/heads/flights/${flight.id}`)).toBeNull();
			expect((await git.history(flight.artifact!.head!))[0]?.oid).toBe(flight.artifact?.head);
		}
	});

	it("is reproducible: two runs produce identical canonical history", async () => {
		const a = await newTower();
		const b = await newTower();
		await runTo(a.tower, "land-021");
		await runTo(b.tower, "land-021");
		expect(a.tower.state.canonical.head).toBe(b.tower.state.canonical.head);
	});

	it("resets to the seed", async () => {
		const { tower } = await newTower();
		const seedHead = tower.state.canonical.head;
		await runTo(tower, "land-022");
		await tower.reset();
		expect(tower.state.flights).toEqual([]);
		expect(tower.state.canonical.head).toBe(seedHead);
		await runTo(tower, "land-021");
		expect(tower.state.flights.every((f) => f.phase === "landed")).toBe(true);
	});
});
