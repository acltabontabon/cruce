import { Controller, type ControllerState, initialState, type TowerEvent } from "../core/controller.ts";
import type { Flight, ProjectInfo } from "../core/domain.ts";
import type { GateResult } from "../core/publish-gate.ts";
import { seedFiles } from "../demo/scenario.ts";
import { candidatePairs, type DecisionJudge } from "../intelligence/judge.ts";
import { buildIndex } from "../intelligence/structural-index.ts";
import type { GitAuthor } from "./git/workspace.ts";
import { CANONICAL, flightRef, type ProjectGit, TOWER_AUTHOR } from "./project-git.ts";

/**
 * The control tower runtime: the authoritative controller state plus the Git work around it.
 * Runtime-agnostic — the Durable Object supplies storage, alarms, and WebSockets; tests supply
 * in-memory equivalents and run the whole demo with real Git.
 */

export interface TowerStore {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
	delete(key: string): void;
	appendEvents(events: TowerEvent[]): void;
}

export interface TowerHooks {
	onChange(state: ControllerState, events: TowerEvent[]): void;
	/** Called after a Flight repo is created (e.g. to subscribe to its Artifacts events). */
	onRepo?(repo: string): Promise<void>;
	onRepoRemoved?(repo: string): Promise<void>;
	/** Keep background work alive (Durable Object `ctx.waitUntil`). */
	background?(work: Promise<unknown>): void;
}

export interface Submission {
	parent?: string;
	files: Record<string, string | null>;
	message: string;
	author?: GitAuthor;
	/** The agent's own commit id, if it committed locally (verified against Cruce's rebuild). */
	claimedCommit?: string;
}

export interface PublishOutcome {
	approved: boolean;
	commit: string;
	gate: GateResult & { reasons: string[] };
	matchesClaim?: boolean;
}

/** Fixed clock for demo commits, so every run produces the same commit ids. */
export const DEMO_EPOCH = Date.UTC(2026, 9, 14, 9, 0, 0) / 1000;

export class Tower {
	constructor(
		readonly project: ProjectInfo,
		readonly git: ProjectGit,
		private readonly store: TowerStore,
		private readonly hooks: TowerHooks,
		private readonly now: () => number = Date.now,
		private readonly firstFlight = 1,
		private readonly judges: DecisionJudge[] = [],
	) {}

	/** Restore persisted Git settings (call once after construction). */
	restore(): this {
		this.git.epoch = this.store.get<number>("repoEpoch") ?? 0;
		return this;
	}

	// ── state ───────────────────────────────────────────────────────────

	get state(): ControllerState {
		const s = this.store.get<ControllerState>("state");
		if (!s) throw new Error("project not bootstrapped");
		return s;
	}

	get ready(): boolean {
		return this.store.get("state") !== undefined;
	}

	/** Apply controller commands atomically: one snapshot in, one snapshot + events out. */
	mutate<T>(fn: (c: Controller) => T): T {
		const c = new Controller(this.state, this.now());
		const out = fn(c);
		const { state, events } = c.commit();
		this.store.put("state", state);
		if (events.length) this.store.appendEvents(events);
		this.hooks.onChange(state, events);
		if (this.judges.length && events.some((e) => e.type === "plan.filed" || e.type === "plan.amended")) {
			const work = this.judge();
			this.hooks.background?.(work);
		}
		return out;
	}

	/** Level-4 bounded judgment over Flights sharing modules; findings are advisory inputs to traffic. */
	async judge(): Promise<void> {
		const pairs = candidatePairs(this.state.flights, this.state.index);
		const findings = (await Promise.all(this.judges.map((j) => j.judge(pairs).catch(() => [])))).flat();
		const key = (f: { flights: string[]; summary: string }) => `${[...f.flights].sort().join("|")}:${f.summary}`;
		const before = this.state.semantic.map(key).sort().join("\n");
		if (findings.map(key).sort().join("\n") === before) return;
		this.mutate((c) => c.setSemantic(findings));
	}

	flight(id: string): Flight {
		const f = this.state.flights.find((x) => x.id === id);
		if (!f) throw new Error(`unknown flight ${id}`);
		return f;
	}

	/** Commit timestamps: a fixed demo clock (reproducible ids) or wall time (live). */
	private author(identity: { name: string; email: string } = TOWER_AUTHOR): GitAuthor {
		if (this.project.mode !== "demo") return { ...identity, timestamp: Math.floor(this.now() / 1000) };
		const tick = this.store.get<number>("gitClock") ?? 0;
		this.store.put("gitClock", tick + 1);
		return { ...identity, timestamp: DEMO_EPOCH + tick * 60 };
	}

	flightAuthor(f: Flight): GitAuthor {
		return this.author({ name: `${f.id} · ${f.agentRuntime}`, email: `${f.id.toLowerCase()}@agents.cruce.acltabontabon.com` });
	}

	// ── lifecycle ───────────────────────────────────────────────────────

	/** Create (or attach to) the canonical repository and index it. Idempotent. */
	async bootstrap(): Promise<void> {
		if (this.ready) return;
		this.store.put("gitClock", 0);
		const seed = seedFiles();
		const { head, remote } = await this.git.ensureCanonical(
			seed,
			this.author(),
			`Cruce ${this.project.mode} project: ${this.project.name}`,
		);
		const files = await this.git.filesAt(head);
		const index = buildIndex(files, head);
		const state = initialState({ ...this.project, remote }, index, head, this.now(), this.firstFlight);
		this.store.put("state", state);
		const subscribed = this.hooks.onRepo
			? await this.hooks.onRepo(this.project.repo).then(
					() => true,
					() => false,
				)
			: false;
		this.mutate((c) =>
			c.note(
				"project.ready",
				this.git.backend === "artifacts" ? "artifacts" : "git",
				`Canonical ${this.project.repo} @ ${head.slice(0, 7)}`,
				undefined,
				[
					this.git.backend === "artifacts" ? `Artifacts ${this.git.namespace}/${this.project.repo}` : "local Git backend (offline)",
					`indexed ${index.files.length} files in ${index.modules.length} modules (${index.indexer})`,
					...(subscribed ? [`subscribed to ${this.project.repo} push events`] : []),
				],
			),
		);
	}

	/** Give a Flight its own repository: an Artifacts fork of canonical. */
	async provision(flightId: string): Promise<void> {
		const f = this.flight(flightId);
		this.mutate((c) => c.setPhase(flightId, "provisioning"));
		const artifact = await this.git.createFlightWorkspace(flightId, `Cruce Flight ${flightId}: ${f.title}`);
		this.mutate((c) => {
			c.attachArtifact(flightId, artifact);
			c.setPhase(flightId, "discovery");
		});
		await this.hooks
			.onRepo?.(artifact.repo)
			.catch((e) =>
				this.mutate((c) =>
					c.note("artifacts.event", "artifacts", `Event subscription for ${artifact.repo} not created`, flightId, [String(e)]),
				),
			);
	}

	/**
	 * The publish gate, end to end: Cruce rebuilds the commit from the submitted files, maps the real
	 * diff onto airspace, and only if it is inside clearance pushes it with a 60-second token.
	 */
	async publish(flightId: string, sub: Submission): Promise<PublishOutcome> {
		const f = this.flight(flightId);
		const parent = sub.parent ?? (await this.git.resolve(flightRef(flightId)));
		if (!parent) throw new Error(`${flightId} has no workspace`);
		const staged = await this.git.stageCommit(flightId, {
			parent,
			files: sub.files,
			message: sub.message,
			author: sub.author ?? this.flightAuthor(f),
		});
		const canonicalConfig = (await this.git.filesAt(CANONICAL, (p) => p === "cruce.json"))["cruce.json"];
		const baseIndex = buildIndex({ ...staged.base, ...(canonicalConfig ? { "cruce.json": canonicalConfig } : {}) }, parent);
		const gate = this.mutate((c) => c.requestPublish(flightId, staged.oid, staged.files, sub.message, baseIndex));
		const matchesClaim = sub.claimedCommit ? sub.claimedCommit === staged.oid : undefined;
		if (!gate.approved) return { approved: false, commit: staged.oid, gate, matchesClaim };

		const latest = this.flight(flightId);
		const clearance = this.state.traffic.clearances[flightId];
		await this.git.publish(flightId, staged.oid, {
			cruce: 1,
			kind: "flight-commit",
			flightId,
			missionId: latest.missionId,
			agent: latest.agent,
			agentRuntime: latest.agentRuntime,
			planVersion: latest.plan?.planVersion,
			baseline: latest.baseline,
			intent: latest.plan?.intent,
			clearance: { status: clearance?.status, cleared: clearance?.cleared, held: clearance?.held.map((h) => h.resource) },
			gate: gate.summary,
			touched: gate.touched,
		});
		this.mutate((c) => {
			c.recordPush(flightId, staged.oid, "gate");
			if (matchesClaim === false)
				c.note("push.received", "git", `${flightId}: rebuilt commit differs from the agent's local id`, flightId, [
					"the agent should reset to Cruce's commit",
				]);
		});
		return { approved: true, commit: staged.oid, gate, matchesClaim };
	}

	validate(flightId: string, commit: string, passed: boolean, summary: string) {
		this.mutate((c) => c.recordValidation(flightId, commit, passed, summary));
	}

	/** Git preflight then integration into canonical. Returns whether the Flight landed. */
	async land(flightId: string): Promise<{ landed: boolean; reason?: string }> {
		this.mutate((c) => c.refreshTraffic());
		const blockers = new Controller(this.state, this.now()).landingBlockers(flightId);
		if (blockers.length) {
			this.mutate((c) => c.note("preflight", "cruce", `${flightId} not cleared to land`, flightId, blockers));
			return { landed: false, reason: blockers.join("; ") };
		}
		this.mutate((c) => c.setPhase(flightId, "landing"));
		const pre = await this.git.preflight(flightId);
		this.mutate((c) => c.recordPreflight(flightId, pre));
		if (!pre.clean) {
			this.mutate((c) => c.setPhase(flightId, "executing", "held at landing: actual Git conflict"));
			return { landed: false, reason: `conflict: ${pre.conflicts.join(", ")}` };
		}
		const f = this.flight(flightId);
		const mission = this.state.missions.find((m) => m.id === f.missionId);
		const clearance = this.state.traffic.clearances[flightId];
		const message = `Land ${flightId}: ${f.title}`;
		const outcome = await this.git.land(
			flightId,
			message,
			{
				cruce: 1,
				kind: "landing",
				flightId,
				missionId: f.missionId,
				task: mission?.description,
				agent: f.agent,
				agentRuntime: f.agentRuntime,
				baseline: f.baseline,
				planVersion: f.plan?.planVersion,
				intent: f.plan?.intent,
				planAmendments: f.planHistory.filter((p) => p.amendment).map((p) => ({ version: p.planVersion, ...p.amendment })),
				clearance: { status: clearance?.status, cleared: clearance?.cleared },
				congestion: this.state.traffic.congestions
					.filter((c) => c.flights.includes(flightId))
					.map((c) => ({ with: c.flights.find((x) => x !== flightId), label: c.label, decision: c.rightOfWay, resolution: c.resolution })),
				coordination: this.state.log
					.filter(
						(e) =>
							["clearance", "plan.amended", "publish.rejected", "flight.stale", "lease.yielded", "override", "baseline.refreshed"].includes(
								e.type,
							) &&
							(e.flightId === flightId || e.title.includes(flightId)),
					)
					.slice(-12)
					.map((e) => ({ type: e.type, title: e.title, detail: e.detail?.slice(0, 3) })),
				dependencies: f.plan?.dependencies,
				validation: f.publishes.filter((p) => p.approved).at(-1)?.tests,
				preflight: { mergeBase: pre.mergeBase, clean: pre.clean, staleBase: pre.staleBase },
			},
			this.author(),
		);
		if (!outcome.clean || !outcome.oid) {
			this.mutate((c) => {
				c.recordPreflight(flightId, { ...pre, clean: false, conflicts: outcome.conflicts });
				c.setPhase(flightId, "executing", "held at landing");
			});
			return { landed: false, reason: "merge failed" };
		}
		const files = await this.git.filesAt(outcome.oid);
		const index = buildIndex(files, outcome.oid);
		this.mutate((c) => c.land(flightId, outcome.oid as string, index, message));
		await this.closeFlight(flightId);
		return { landed: true };
	}

	/** Revoke any credentials still issued for a finished Flight's repository. */
	async closeFlight(flightId: string): Promise<void> {
		const revoked = await this.git.closeFlight(flightId).catch(() => 0);
		if (revoked)
			this.mutate((c) =>
				c.note("artifacts.event", "cruce", `${flightId}: revoked ${revoked} remaining token(s) on its repository`, flightId),
			);
	}

	/** Bring a stale Flight onto the new canonical baseline (real merge into its repository). */
	async refresh(flightId: string): Promise<boolean> {
		const outcome = await this.git.refreshFlight(flightId, this.author());
		if (!outcome.clean || !outcome.oid) {
			this.mutate((c) =>
				c.recordPreflight(flightId, {
					clean: false,
					mergeBase: outcome.mergeBase,
					conflicts: outcome.conflicts,
					changedPaths: [],
					staleBase: true,
				}),
			);
			return false;
		}
		const head = this.state.canonical.head;
		this.mutate((c) =>
			c.refreshBaseline(
				flightId,
				outcome.oid as string,
				`merged canonical ${head.slice(0, 7)} into ${this.flight(flightId).artifact?.repo}`,
			),
		);
		return true;
	}

	/** Remove every Flight and return canonical to the seed (demo reset). */
	async reset(): Promise<void> {
		const flights = this.ready ? this.state.flights : [];
		this.store.put("gitClock", 0);
		const head = await this.git.resetToSeed(
			seedFiles(),
			this.author(),
			flights.map((f) => f.id),
		);
		// New Flight repos get fresh names; the old ones are being deleted in the background.
		this.git.epoch = (this.store.get<number>("repoEpoch") ?? 0) + 1;
		this.store.put("repoEpoch", this.git.epoch);
		for (const f of flights) if (f.artifact) await this.hooks.onRepoRemoved?.(f.artifact.repo).catch(() => undefined);
		this.store.delete("state");
		const files = await this.git.filesAt(head);
		const index = buildIndex(files, head);
		const remote = this.git.backend === "artifacts" ? await this.git.remoteOf(this.project.repo) : undefined;
		this.store.put("state", initialState({ ...this.project, remote }, index, head, this.now(), this.firstFlight));
		this.mutate((c) => c.note("project.ready", "cruce", `Demo reset · canonical ${this.project.repo} @ ${head.slice(0, 7)}`));
	}
}
