import { type AirspaceIndex, isAncestorOrEqual, resolveResource, resourceLabel } from "./airspace.ts";
import {
	type AgentKind,
	type ArtifactRef,
	type CanonicalState,
	type Flight,
	type FlightPhase,
	type FlightPlan,
	FlightPlanInput,
	type Lease,
	type Mission,
	type Override,
	type OverrideKind,
	type PlanResource,
	type Priority,
	type ProjectInfo,
	TERMINAL_PHASES,
} from "./domain.ts";
import { LEASE_TTL_MS, LeaseBook } from "./leases.ts";
import { type ChangedFile, evaluatePublish, type GateResult } from "./publish-gate.ts";
import {
	type AttentionItem,
	computeTraffic,
	type FlightClearance,
	isActive,
	planAccesses,
	type SemanticFinding,
	type TrafficPicture,
} from "./traffic.ts";

export type Actor = "cruce" | "agent" | "human" | "git" | "artifacts";

export type TowerEventType =
	| "project.ready"
	| "mission.created"
	| "flight.created"
	| "flight.phase"
	| "flight.activity"
	| "plan.filed"
	| "plan.amended"
	| "plan.rejected"
	| "clearance"
	| "congestion.detected"
	| "congestion.cleared"
	| "lease.yielded"
	| "publish.approved"
	| "publish.rejected"
	| "push.received"
	| "validation"
	| "preflight"
	| "flight.landed"
	| "flight.stale"
	| "baseline.refreshed"
	| "override"
	| "flight.failed"
	| "flight.lost"
	| "artifacts.event"
	| "agent.instruction"
	| "attention";

export interface TowerEvent {
	seq: number;
	at: number;
	type: TowerEventType;
	actor: Actor;
	flightId?: string;
	title: string;
	detail?: string[];
	data?: Record<string, unknown>;
}

export interface ControllerState {
	rev: number;
	project: ProjectInfo;
	index: AirspaceIndex;
	canonical: CanonicalState;
	missions: Mission[];
	flights: Flight[];
	leases: Lease[];
	overrides: Override[];
	semantic: SemanticFinding[];
	attention: AttentionItem[];
	counters: { flight: number; mission: number; event: number };
	traffic: TrafficPicture;
	/** Recent events for the radar; the full audit log is persisted separately. */
	log: TowerEvent[];
}

export class ControllerError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const LOG_LIMIT = 400;
const PLAN_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VIOLATIONS = 3;

export function emptyTraffic(): TrafficPicture {
	return { congestions: [], clearances: {}, edges: [], deadlocks: [], landingOrder: [], attention: [], occupancy: {} };
}

export function initialState(project: ProjectInfo, index: AirspaceIndex, head: string, now: number, firstFlight = 1): ControllerState {
	return {
		rev: 0,
		project,
		index,
		canonical: { head, history: [{ commit: head, message: "Baseline", at: now }] },
		missions: [],
		flights: [],
		leases: [],
		overrides: [],
		semantic: [],
		attention: [],
		counters: { flight: firstFlight - 1, mission: 0, event: 0 },
		traffic: emptyTraffic(),
		log: [],
	};
}

/**
 * The control tower state machine. Construct over a state snapshot, apply commands, then `commit()`
 * to get the next state and the events it produced. All decisions are made here, in ordinary code.
 */
export class Controller {
	private readonly s: ControllerState;
	private readonly events: TowerEvent[] = [];

	constructor(
		state: ControllerState,
		private readonly now: number,
	) {
		this.s = structuredClone(state);
	}

	get state(): Readonly<ControllerState> {
		return this.s;
	}

	commit(): { state: ControllerState; events: TowerEvent[] } {
		this.s.rev++;
		this.s.log = [...this.s.log, ...this.events].slice(-LOG_LIMIT);
		return { state: this.s, events: this.events };
	}

	// ── queries ─────────────────────────────────────────────────────────

	flight(id: string): Flight {
		const f = this.s.flights.find((x) => x.id === id);
		if (!f) throw new ControllerError(`Unknown flight ${id}`, 404);
		return f;
	}

	clearance(id: string): FlightClearance | undefined {
		return this.s.traffic.clearances[id];
	}

	// ── commands ────────────────────────────────────────────────────────

	createMission(input: { title: string; description?: string; priority?: Priority; createdBy?: string; constraints?: string[] }): Mission {
		const id = `M-${String(++this.s.counters.mission).padStart(3, "0")}`;
		const mission: Mission = {
			id,
			title: input.title,
			description: input.description ?? input.title,
			priority: input.priority ?? "normal",
			createdAt: this.now,
			baseRevision: this.s.canonical.head,
			createdBy: input.createdBy ?? "developer",
			constraints: input.constraints,
		};
		this.s.missions.push(mission);
		this.emit("mission.created", "human", `Mission ${id}: ${mission.title}`, undefined, [`priority ${mission.priority}`]);
		return mission;
	}

	createFlight(input: { missionId: string; agent: AgentKind; agentRuntime?: string; title?: string; priority?: Priority }): Flight {
		const mission = this.s.missions.find((m) => m.id === input.missionId);
		if (!mission) throw new ControllerError(`Unknown mission ${input.missionId}`, 404);
		const id = `F-${String(++this.s.counters.flight).padStart(3, "0")}`;
		const flight: Flight = {
			id,
			missionId: mission.id,
			title: input.title ?? mission.title,
			agent: input.agent,
			agentRuntime: input.agentRuntime ?? input.agent,
			priority: input.priority ?? mission.priority,
			phase: "queued",
			createdAt: this.now,
			baseline: this.s.canonical.head,
			planHistory: [],
			publishes: [],
			violations: 0,
		};
		this.s.flights.push(flight);
		this.emit("flight.created", "cruce", `${id} created for ${mission.id}`, id, [flight.title, `agent ${flight.agentRuntime}`]);
		return flight;
	}

	attachArtifact(flightId: string, artifact: ArtifactRef) {
		const f = this.flight(flightId);
		f.artifact = artifact;
		f.baseline = artifact.baseCommit;
		this.emit("flight.phase", "artifacts", `${flightId} workspace forked: ${artifact.repo}`, flightId, [
			`fork of ${artifact.forkedFrom} at ${artifact.baseCommit.slice(0, 7)}`,
		]);
	}

	setSandbox(flightId: string, sandboxId: string) {
		this.flight(flightId).sandboxId = sandboxId;
	}

	setPhase(flightId: string, phase: FlightPhase, note?: string) {
		const f = this.flight(flightId);
		if (TERMINAL_PHASES.has(f.phase)) throw new ControllerError(`${flightId} is ${f.phase}`, 409);
		if (f.phase === phase) return;
		f.phase = phase;
		if (phase === "discovery" && !f.startedAt) f.startedAt = this.now;
		this.emit("flight.phase", "cruce", `${flightId} → ${phase.toUpperCase()}`, flightId, note ? [note] : undefined);
		this.recompute();
	}

	reportActivity(flightId: string, text: string) {
		const f = this.flight(flightId);
		f.activity = { text: text.slice(0, 300), at: this.now };
		f.lastHeartbeat = this.now;
		this.leaseBook((b) => b.heartbeat(flightId, this.now));
		this.emit("flight.activity", "agent", `${flightId}: ${f.activity.text}`, flightId);
	}

	heartbeat(flightId: string) {
		const f = this.flight(flightId);
		f.lastHeartbeat = this.now;
		this.leaseBook((b) => b.heartbeat(flightId, this.now));
	}

	/**
	 * File (or amend) a Flight Plan. Discovery comes first; this is where a Flight declares territory.
	 * Every filing increments the plan version and triggers traffic re-evaluation.
	 */
	submitPlan(flightId: string, raw: unknown, reason?: string): { plan: FlightPlan; clearance: FlightClearance } {
		const f = this.flight(flightId);
		if (TERMINAL_PHASES.has(f.phase)) throw new ControllerError(`${flightId} is ${f.phase}`, 409);
		const parsed = FlightPlanInput.safeParse(raw);
		if (!parsed.success) {
			this.emit(
				"plan.rejected",
				"cruce",
				`${flightId} plan rejected: invalid schema`,
				flightId,
				parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
			);
			throw new ControllerError(`Invalid flight plan: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
		}
		const prev = f.plan;
		const plan: FlightPlan = {
			...parsed.data,
			flightId,
			planVersion: (prev?.planVersion ?? 0) + 1,
			filedAt: this.now,
			baseline: f.baseline,
		};
		if (prev) {
			const before = new Set(
				planAccesses(prev, this.s.index)
					.filter((a) => a.origin === "declared")
					.map((a) => `${a.mode}:${a.resource}`),
			);
			const after = new Set(
				planAccesses(plan, this.s.index)
					.filter((a) => a.origin === "declared")
					.map((a) => `${a.mode}:${a.resource}`),
			);
			const fmt = (k: string) => {
				const [mode, ...rest] = k.split(":");
				return `${mode} ${resourceLabel(rest.join(":"), this.s.index)}`;
			};
			plan.amendment = {
				reason: reason ?? (f.stale ? `re-plan after ${f.stale.byFlight} landed` : "route amendment"),
				added: [...after].filter((k) => !before.has(k)).map(fmt),
				removed: [...before].filter((k) => !after.has(k)).map(fmt),
			};
		}
		f.plan = plan;
		f.planHistory.push(plan);
		f.violations = 0;
		const wasStale = f.stale;
		f.stale = undefined;
		if (f.phase === "discovery" || f.phase === "queued" || f.phase === "provisioning") f.phase = "planned";

		const unresolved = [...plan.writeSet, ...plan.readSet]
			.map((r) => resolveResource(r, this.s.index))
			.filter((r) => r.isNew)
			.map((r) => r.requested);
		const detail = [
			plan.summary,
			`write: ${plan.writeSet.map((w) => w.resource).join(", ") || "—"}`,
			...(plan.contractSet.length ? [`contract: ${plan.contractSet.map((c) => `${c.resource} (${c.change})`).join(", ")}`] : []),
			...(unresolved.length ? [`new airspace: ${unresolved.join(", ")}`] : []),
		];
		if (prev) {
			this.emit(
				"plan.amended",
				"agent",
				`${flightId} filed Flight Plan v${plan.planVersion}`,
				flightId,
				[
					`reason: ${plan.amendment?.reason}`,
					...(plan.amendment?.added.length ? [`+ ${plan.amendment.added.join(", ")}`] : []),
					...(plan.amendment?.removed.length ? [`− ${plan.amendment.removed.join(", ")}`] : []),
				],
				{ planVersion: plan.planVersion, wasStale: !!wasStale },
			);
		} else {
			this.emit("plan.filed", "agent", `${flightId} filed Flight Plan v1`, flightId, detail, { planVersion: 1 });
		}
		this.recompute();
		return { plan, clearance: this.clearance(flightId) as FlightClearance };
	}

	/** Mid-flight route expansion: add airspace to the current plan and re-run traffic analysis. */
	requestAirspace(flightId: string, resources: PlanResource[], reason: string, contract?: FlightPlan["contractSet"]) {
		const f = this.flight(flightId);
		if (!f.plan) throw new ControllerError(`${flightId} has not filed a plan`, 409);
		const { flightId: _f, planVersion: _v, filedAt: _t, baseline: _b, amendment: _a, ...fields } = f.plan;
		const next = {
			...fields,
			writeSet: [...fields.writeSet, ...resources.filter((r) => !fields.writeSet.some((w) => w.resource === r.resource))],
			contractSet: [...fields.contractSet, ...(contract ?? [])],
		};
		return this.submitPlan(flightId, next, reason);
	}

	/** Publish gate: decide whether the Flight's diff may be pushed. */
	/**
	 * `baseIndex` indexes the diff's base versions of the changed files; symbol line ranges must come
	 * from the same revision the diff was computed against.
	 */
	requestPublish(
		flightId: string,
		commit: string,
		changes: ChangedFile[],
		message: string,
		baseIndex?: AirspaceIndex,
	): GateResult & { reasons: string[] } {
		const f = this.flight(flightId);
		const c = this.clearance(flightId);
		const reasons: string[] = [];
		if (!f.plan || !c) reasons.push("no Flight Plan on file");
		if (f.stale) reasons.push(`baseline changed when ${f.stale.byFlight} landed; amend the Flight Plan first`);
		const gate = evaluatePublish(c?.cleared ?? [], changes, baseIndex ?? this.s.index);
		const approved = gate.approved && reasons.length === 0;
		f.publishes.push({ at: this.now, commit, approved, touched: gate.touched, outside: gate.outside.map((o) => o.resource), message });
		if (approved) {
			this.emit(
				"publish.approved",
				"cruce",
				`${flightId} publish approved · ${commit.slice(0, 7)}`,
				flightId,
				[gate.summary, ...gate.touched.map((t) => `✓ ${resourceLabel(t, this.s.index)}`)],
				{ commit },
			);
		} else {
			f.violations++;
			const detail = [...reasons, ...gate.outside.map((o) => `× ${resourceLabel(o.resource, this.s.index)} — ${o.reason}`)];
			this.emit("publish.rejected", "cruce", `${flightId} publish rejected · amendment required`, flightId, detail, { commit });
			if (f.violations >= MAX_VIOLATIONS) {
				this.raise({
					id: `violation:${flightId}`,
					kind: "violation",
					severity: "high",
					flights: [flightId],
					title: `${flightId} keeps writing outside its clearance`,
					detail: `${f.violations} rejected publishes. Review the Flight or cancel it.`,
				});
			}
		}
		return { ...gate, approved, reasons, summary: reasons.length ? reasons.join("; ") : gate.summary };
	}

	/** A push observed on the Flight's Artifacts repo (event-driven; idempotent per commit). */
	recordPush(flightId: string, commit: string, source: "event" | "gate") {
		const f = this.flight(flightId);
		if (f.artifact?.head === commit) return false;
		if (f.artifact) f.artifact.head = commit;
		const pub = [...f.publishes].reverse().find((p) => p.commit === commit);
		if (pub) pub.verified = true;
		this.emit(
			"push.received",
			source === "event" ? "artifacts" : "git",
			`${flightId} pushed ${commit.slice(0, 7)}`,
			flightId,
			[pub ? (pub.approved ? "matches an approved publish" : "matches a REJECTED publish") : "no matching publish request"],
			{ commit },
		);
		if (!pub || !pub.approved) {
			this.raise({
				id: `unapproved-push:${flightId}:${commit}`,
				kind: "violation",
				severity: "high",
				flights: [flightId],
				title: `${flightId} pushed ${commit.slice(0, 7)} without an approved publish`,
				detail: "The commit is preserved in the Flight's repository but will not land.",
			});
		}
		return true;
	}

	recordValidation(flightId: string, commit: string, passed: boolean, summary: string) {
		const f = this.flight(flightId);
		const pub = [...f.publishes].reverse().find((p) => p.commit === commit) ?? f.publishes.at(-1);
		if (pub) pub.tests = { passed, summary };
		this.emit("validation", "cruce", `${flightId} validation ${passed ? "passed" : "FAILED"}`, flightId, [summary], { commit, passed });
	}

	recordPreflight(
		flightId: string,
		result: { clean: boolean; mergeBase: string; conflicts: string[]; changedPaths: string[]; staleBase: boolean },
	) {
		this.emit(
			"preflight",
			"git",
			`${flightId} Git preflight: ${result.clean ? "clean merge" : `${result.conflicts.length} conflict(s)`}`,
			flightId,
			[
				`merge-base ${result.mergeBase.slice(0, 7)} · canonical ${this.s.canonical.head.slice(0, 7)}${result.staleBase ? " (baseline behind)" : ""}`,
				`${result.changedPaths.length} path(s) changed`,
				...result.conflicts.map((c) => `conflict: ${c}`),
			],
			{ ...result },
		);
		if (!result.clean) {
			this.raise({
				id: `git-conflict:${flightId}`,
				kind: "git-conflict",
				severity: "high",
				flights: [flightId],
				title: `${flightId} has an actual Git conflict with canonical`,
				detail: `Conflicting paths: ${result.conflicts.join(", ")}. Not landed automatically.`,
			});
		}
	}

	/** Why a Flight may not land yet (empty = ready). */
	landingBlockers(flightId: string): string[] {
		const f = this.flight(flightId);
		const c = this.clearance(flightId);
		const out: string[] = [];
		if (!f.plan) out.push("no Flight Plan");
		if (f.stale) out.push(`stale: re-plan against ${f.stale.newBaseline.slice(0, 7)}`);
		if (c?.held.length) out.push(`holding ${c.held.map((h) => resourceLabel(h.resource, this.s.index)).join(", ")}`);
		for (const la of c?.landAfter ?? []) {
			const other = this.s.flights.find((x) => x.id === la.flightId);
			if (other && isActive(other)) out.push(`must land after ${la.flightId}`);
		}
		const last = f.publishes.filter((p) => p.approved).at(-1);
		if (!last) out.push("nothing published");
		else if (last.tests && !last.tests.passed) out.push("validation failed");
		return out;
	}

	/**
	 * A Flight landed: its work is integrated into canonical. This is an event that affects other
	 * Flights — anyone whose route intersects what changed is marked stale and must re-plan.
	 */
	land(flightId: string, mergeCommit: string, newIndex: AirspaceIndex | undefined, message: string) {
		const f = this.flight(flightId);
		const blockers = this.landingBlockers(flightId);
		if (blockers.length) throw new ControllerError(`${flightId} cannot land: ${blockers.join("; ")}`, 409);
		const landedPlan = f.plan as FlightPlan;
		const changed = planAccesses(landedPlan, this.s.index).filter((a) => a.mode !== "read" && a.origin === "declared");

		f.phase = "landed";
		f.landedAt = this.now;
		f.landedCommit = mergeCommit;
		this.leaseBook((b) => b.release(flightId));
		this.s.canonical.head = mergeCommit;
		this.s.canonical.history.push({ commit: mergeCommit, flightId, message, at: this.now });
		this.s.attention = this.s.attention.filter((a) => !a.flights.includes(flightId) || a.kind === "deadlock");

		this.emit(
			"flight.landed",
			"cruce",
			`${flightId} LANDED · canonical → ${mergeCommit.slice(0, 7)}`,
			flightId,
			[message, `changed: ${changed.map((c) => resourceLabel(c.resource, this.s.index)).join(", ")}`],
			{ commit: mergeCommit },
		);

		// Re-evaluate everyone else against the new baseline (using the pre-landing index for overlap).
		for (const other of this.s.flights) {
			if (other.id === flightId || !isActive(other)) continue;
			const mine = planAccesses(other.plan, this.s.index);
			const reasons: string[] = [];
			for (const c of changed) {
				for (const a of mine) {
					if (!isAncestorOrEqual(c.resource, a.resource, this.s.index) && !isAncestorOrEqual(a.resource, c.resource, this.s.index))
						continue;
					const what = resourceLabel(c.resource, this.s.index);
					if (c.mode === "contract")
						reasons.push(`${what} contract changed (${a.mode === "read" ? "you depend on it" : "you planned to modify it"})`);
					else if (a.mode !== "read") reasons.push(`${what} was modified by ${flightId}; your planned change must be re-based`);
					else reasons.push(`${what} was modified by ${flightId}`);
				}
			}
			for (const assumption of other.plan.assumptions) {
				if (
					changed.some(
						(c) =>
							c.mode === "contract" &&
							assumption.toLowerCase().includes(resourceLabel(c.resource, this.s.index).split(".")[0].toLowerCase().slice(0, 5)),
					)
				) {
					reasons.push(`assumption no longer holds: “${assumption}”`);
				}
			}
			const unique = [...new Set(reasons)];
			if (unique.length) {
				other.stale = { since: this.now, byFlight: flightId, reasons: unique, newBaseline: mergeCommit };
				this.emit("flight.stale", "cruce", `${other.id} marked STALE by ${flightId}'s landing`, other.id, unique);
			}
		}
		if (newIndex) this.s.index = newIndex;
		this.recompute();
	}

	refreshBaseline(flightId: string, commit: string, note?: string) {
		const f = this.flight(flightId);
		f.baseline = commit;
		if (f.artifact) f.artifact.baseCommit = commit;
		this.emit("baseline.refreshed", "git", `${flightId} baseline refreshed → ${commit.slice(0, 7)}`, flightId, note ? [note] : undefined);
	}

	fail(flightId: string, reason: string, lost = false) {
		const f = this.flight(flightId);
		if (TERMINAL_PHASES.has(f.phase)) return;
		f.phase = lost ? "lost" : "failed";
		f.failureReason = reason;
		const released = this.leaseBook((b) => b.release(flightId));
		this.emit(lost ? "flight.lost" : "flight.failed", "cruce", `${flightId} ${lost ? "LOST" : "FAILED"}: ${reason}`, flightId, [
			`released ${released.length} lease(s); dependent Flights re-evaluated`,
			"its Artifacts repository is preserved for retry or inspection",
		]);
		const dependents = this.s.flights.filter((x) => isActive(x) && x.plan.dependencies.includes(flightId)).map((x) => x.id);
		if (lost || dependents.length) {
			this.raise({
				id: `${lost ? "lost" : "failed"}:${flightId}`,
				kind: dependents.length ? "dependency-failed" : "flight-lost",
				severity: dependents.length ? "high" : "medium",
				flights: [flightId, ...dependents],
				title: `${flightId} ${lost ? "lost contact" : "failed"}${dependents.length ? `; ${dependents.join(", ")} depend on it` : ""}`,
				detail: reason,
			});
		}
		this.recompute();
	}

	cancel(flightId: string, by: string) {
		const f = this.flight(flightId);
		if (TERMINAL_PHASES.has(f.phase)) return;
		f.phase = "cancelled";
		this.leaseBook((b) => b.release(flightId));
		this.emit("flight.phase", "human", `${flightId} CANCELLED by ${by}`, flightId);
		this.recompute();
	}

	applyOverride(congestionKey: string, kind: OverrideKind, by: string, flightId?: string) {
		if (!this.s.traffic.congestions.some((c) => c.key === congestionKey) && kind !== "accept") {
			throw new ControllerError(`No congestion ${congestionKey}`, 404);
		}
		if (kind === "first" && (!flightId || !congestionKey.split("|").includes(flightId))) {
			throw new ControllerError("`first` needs one of the two flights", 400);
		}
		this.s.overrides = this.s.overrides.filter((o) => o.congestionKey !== congestionKey);
		this.s.overrides.push({ congestionKey, kind, flightId, at: this.now, by });
		const text: Record<OverrideKind, string> = {
			accept: "accepted Cruce's recommendation",
			"allow-both": "allowed both Flights to proceed",
			first: `gave ${flightId} right-of-way`,
			"hold-both": "held both Flights",
		};
		this.emit("override", "human", `${by} ${text[kind]} · ${congestionKey.replace("|", " × ")}`, undefined, undefined, {
			congestionKey,
			kind,
			flightId,
		});
		this.recompute();
	}

	clearOverride(congestionKey: string, by: string) {
		const before = this.s.overrides.length;
		this.s.overrides = this.s.overrides.filter((o) => o.congestionKey !== congestionKey);
		if (before !== this.s.overrides.length) {
			this.emit("override", "human", `${by} restored automatic coordination · ${congestionKey.replace("|", " × ")}`, undefined, undefined, {
				congestionKey,
				kind: "auto",
			});
			this.recompute();
		}
	}

	setSemantic(findings: SemanticFinding[]) {
		this.s.semantic = findings;
		this.recompute();
	}

	setIndex(index: AirspaceIndex) {
		this.s.index = index;
		this.recompute();
	}

	dismissAttention(id: string, by: string) {
		const item = this.s.attention.find((a) => a.id === id);
		this.s.attention = this.s.attention.filter((a) => a.id !== id);
		if (item) this.emit("attention", "human", `${by} acknowledged: ${item.title}`);
	}

	/** Time-driven checks: lease expiry (lost agents) and plan timeouts. */
	tick() {
		const book = new LeaseBook(this.s.leases);
		for (const flightId of book.expired(this.now)) {
			const f = this.s.flights.find((x) => x.id === flightId);
			if (f && !TERMINAL_PHASES.has(f.phase) && (f.lastHeartbeat ?? 0) + LEASE_TTL_MS <= this.now) {
				this.fail(flightId, "clearance lease expired without heartbeat", true);
			}
		}
		for (const f of this.s.flights) {
			if (f.phase === "discovery" && f.startedAt !== undefined && this.now - f.startedAt > PLAN_TIMEOUT_MS && !f.plan) {
				this.raise({
					id: `plan-timeout:${f.id}`,
					kind: "plan-timeout",
					severity: "medium",
					flights: [f.id],
					title: `${f.id} has not filed a Flight Plan`,
					detail: "No code execution happens without a plan. Retry discovery or cancel.",
				});
				this.fail(f.id, "plan timeout: no Flight Plan filed after discovery");
			}
		}
	}

	/** Record an orchestration event (Git, Artifacts, agent runtime) in the tower log. */
	note(type: TowerEventType, actor: Actor, title: string, flightId?: string, detail?: string[], data?: Record<string, unknown>) {
		this.emit(type, actor, title, flightId, detail, data);
	}

	// ── internals ───────────────────────────────────────────────────────

	private leaseBook<T>(fn: (b: LeaseBook) => T): T {
		const book = new LeaseBook(this.s.leases);
		const out = fn(book);
		this.s.leases = book.all();
		return out;
	}

	private raise(item: AttentionItem) {
		if (this.s.attention.some((a) => a.id === item.id)) return;
		this.s.attention.push(item);
		this.emit("attention", "cruce", `Attention: ${item.title}`, item.flights[0], [item.detail]);
	}

	/** Recompute traffic, reconcile leases, and emit what changed (clearances, congestion, yields). */
	private recompute() {
		const prev = this.s.traffic;
		const next = computeTraffic({ index: this.s.index, flights: this.s.flights, overrides: this.s.overrides, semantic: this.s.semantic });
		this.s.traffic = next;
		const label = (r: string) => resourceLabel(r, this.s.index);

		for (const c of next.congestions) {
			if (prev.congestions.some((p) => p.key === c.key && p.level === c.level && p.control === c.control)) continue;
			this.emit(
				"congestion.detected",
				"cruce",
				`Congestion · ${c.flights.join(" × ")} · ${c.label || "intent"}`,
				undefined,
				[...c.why, ...(c.rightOfWay ? [`right-of-way: ${c.rightOfWay.winner} (${c.rightOfWay.rule})`, ...c.rightOfWay.because] : [])],
				{ key: c.key, level: c.level, severity: c.severity, control: c.control },
			);
		}
		for (const p of prev.congestions) {
			if (!next.congestions.some((c) => c.key === p.key)) {
				this.emit("congestion.cleared", "cruce", `Congestion cleared · ${p.flights.join(" × ")}`, undefined, undefined, { key: p.key });
			}
		}

		const book = new LeaseBook(this.s.leases);
		for (const [flightId, c] of Object.entries(next.clearances)) {
			const f = this.s.flights.find((x) => x.id === flightId);
			if (!f) continue;
			const was = prev.clearances[flightId];
			const yielded = book
				.held(flightId)
				.filter((l) => !c.cleared.includes(l.resource))
				.map((l) => l.resource);
			book.retain(flightId, new Set(c.cleared));
			for (const r of c.cleared) book.grant(flightId, r, this.now);
			if (yielded.length) {
				this.emit(
					"lease.yielded",
					"cruce",
					`${flightId} YIELDS ${yielded.map(label).join(", ")}`,
					flightId,
					c.held.filter((h) => yielded.includes(h.resource)).map((h) => h.reason),
				);
			}
			const changed =
				!was ||
				was.status !== c.status ||
				was.cleared.join() !== c.cleared.join() ||
				was.held.map((h) => h.resource + h.waitingOn).join() !== c.held.map((h) => h.resource + h.waitingOn).join();
			if (changed) {
				const headline = { clear: "CLEAR", partial: "PARTIAL CLEARANCE", hold: "HOLD", none: "—" }[c.status];
				this.emit(
					"clearance",
					"cruce",
					`${flightId} → ${headline}`,
					flightId,
					[
						...c.cleared.map((r) => `✓ ${label(r)}`),
						...c.held.map((h) => `× ${label(h.resource)} — ${h.reason}`),
						...c.landAfter.map((l) => `lands after ${l.flightId}`),
					],
					{ status: c.status, cleared: c.cleared, held: c.held.map((h) => h.resource) },
				);
				if (c.status !== "hold" && f.phase === "planned") f.phase = "executing";
			}
		}
		for (const id of Object.keys(prev.clearances)) {
			if (!next.clearances[id]) book.release(id);
		}
		this.s.leases = book.all();
	}

	private emit(type: TowerEventType, actor: Actor, title: string, flightId?: string, detail?: string[], data?: Record<string, unknown>) {
		this.events.push({ seq: ++this.s.counters.event, at: this.now, type, actor, flightId, title, detail, data });
	}
}

/** Instructions handed to the agent: the cleared route in plain language (provider-neutral). */
export function clearanceBrief(state: ControllerState, flightId: string): string {
	const f = state.flights.find((x) => x.id === flightId);
	const c = state.traffic.clearances[flightId];
	if (!f || !c) return "No Flight Plan on file. Investigate freely (read-only), then file a Flight Plan.";
	const label = (r: string) => resourceLabel(r, state.index);
	const lines = [
		`Flight ${f.id} · plan v${f.plan?.planVersion} · clearance ${c.status.toUpperCase()}`,
		c.cleared.length ? `You are cleared to modify: ${c.cleared.map(label).join(", ")}.` : "You are not cleared to modify anything yet.",
	];
	if (c.held.length) lines.push(`HOLD — do not modify: ${c.held.map((h) => `${label(h.resource)} (${h.reason})`).join("; ")}.`);
	if (c.landAfter.length) lines.push(`You will land after ${c.landAfter.map((l) => l.flightId).join(", ")}.`);
	if (f.stale) lines.push(`Your baseline is stale: ${f.stale.reasons.join("; ")}. Re-read the code and file an amended Flight Plan.`);
	lines.push("You may read anything. To touch anything else, request a Flight Plan amendment first.");
	return lines.join("\n");
}
