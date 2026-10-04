import {
	type AirspaceIndex,
	dependentsOf,
	fileId,
	isAncestorOrEqual,
	parseResourceId,
	resolveResource,
	resourceLabel,
} from "./airspace.ts";
import { type Access, type CongestionLevel, type Control, interactions, SEVERITY_RANK, type Severity } from "./conflict-matrix.ts";
import { DependencyGraph, type Edge } from "./dependency-graph.ts";
import { type ClearanceStatus, type Flight, type FlightPlan, type Override, PRIORITY_RANK, TERMINAL_PHASES } from "./domain.ts";
import { type Contender, decideRightOfWay, type RightOfWay } from "./right-of-way.ts";

/**
 * The clearance engine. Given every active Flight Plan, it computes the full traffic picture:
 * congestion between pairs of Flights, who has right-of-way, which airspace each Flight is cleared
 * to write, which it must hold, landing order, and deadlocks.
 *
 * The engine is a pure function of its input, so the controller recomputes it after every event
 * and the picture is always consistent with the authoritative state.
 */

export interface SemanticFinding {
	flights: [string, string];
	summary: string;
	confidence: number;
	recommendation: "caution" | "escalate";
	source: string;
}

export interface TrafficInput {
	index: AirspaceIndex;
	flights: Flight[];
	overrides: Override[];
	semantic?: SemanticFinding[];
}

export interface InteractionView {
	flight: string;
	other: string;
	resource: string;
	otherResource: string;
	mode: Access["mode"];
	otherMode: Access["mode"];
	origin: Access["origin"];
	otherOrigin: Access["origin"];
	level: CongestionLevel;
	severity: Severity;
	control: Control;
	rule: string;
}

export interface Congestion {
	key: string;
	flights: [string, string];
	label: string;
	level: CongestionLevel;
	/** Every congestion level present between the pair (e.g. structural and contract). */
	levels: CongestionLevel[];
	severity: Severity;
	control: Control;
	/** The contested airspace (the more specific side of each overlapping pair). */
	resources: string[];
	interactions: InteractionView[];
	rightOfWay?: RightOfWay;
	why: string[];
	plan: string[];
	resolution: "auto" | "override" | "attention";
	override?: Override;
}

export interface HeldResource {
	resource: string;
	waitingOn: string;
	congestionKey: string;
	reason: string;
}

export interface FlightClearance {
	flightId: string;
	status: ClearanceStatus;
	cleared: string[];
	held: HeldResource[];
	reads: string[];
	landAfter: { flightId: string; reason: string }[];
	cautions: string[];
}

export interface AttentionItem {
	id: string;
	kind: "deadlock" | "semantic" | "git-conflict" | "violation" | "flight-lost" | "plan-timeout" | "dependency-failed";
	severity: Severity;
	flights: string[];
	title: string;
	detail: string;
}

export interface TrafficPicture {
	congestions: Congestion[];
	clearances: Record<string, FlightClearance>;
	edges: Edge[];
	deadlocks: string[][];
	landingOrder: string[] | null;
	attention: AttentionItem[];
	/** Resource id → flights routing through it (for the radar). */
	occupancy: Record<string, { flightId: string; mode: Access["mode"] }[]>;
}

export const pairKey = (a: string, b: string) => [a, b].sort().join("|");

/** Flights the controller is actively coordinating: filed a plan, not finished. */
export function isActive(f: Flight): f is Flight & { plan: FlightPlan } {
	return !!f.plan && !TERMINAL_PHASES.has(f.phase);
}

/** Resolve a plan into access entries, including dependencies derived from the import graph. */
export function planAccesses(plan: FlightPlan, index: AirspaceIndex): Access[] {
	const byKey = new Map<string, Access>();
	const put = (a: Access) => {
		const prev = byKey.get(a.resource);
		const rank = { read: 0, write: 1, contract: 2 } as const;
		if (!prev || rank[a.mode] > rank[prev.mode] || (prev.origin === "derived" && a.origin === "declared")) {
			byKey.set(a.resource, a);
		}
	};
	for (const r of plan.readSet) put({ resource: resolveResource(r, index).id, mode: "read", origin: "declared", requested: r.resource });
	for (const r of plan.writeSet) put({ resource: resolveResource(r, index).id, mode: "write", origin: "declared", requested: r.resource });
	for (const c of plan.contractSet) {
		put({
			resource: resolveResource({ type: "symbol", resource: c.resource }, index).id,
			mode: "contract",
			origin: "declared",
			requested: c.resource,
		});
	}
	// Static analysis: a Flight writing a file implicitly depends on what that file imports.
	const declared = [...byKey.values()];
	for (const a of declared) {
		if (a.mode === "read") continue;
		const p = parseResourceId(a.resource);
		const file = p.file;
		if (!file) continue;
		const imports = index.files.find((f) => f.path === file)?.imports ?? [];
		for (const imp of imports) {
			const id = fileId(imp);
			if (!byKey.has(id) && !declared.some((d) => isAncestorOrEqual(id, d.resource, index) || isAncestorOrEqual(d.resource, id, index))) {
				byKey.set(id, { resource: id, mode: "read", origin: "derived", requested: `imports ${imp.split("/").pop()}` });
			}
		}
	}
	return [...byKey.values()].sort((a, b) => a.resource.localeCompare(b.resource));
}

export function writeResources(accesses: Access[]): string[] {
	return accesses.filter((a) => a.mode !== "read").map((a) => a.resource);
}

export function computeTraffic(input: TrafficInput): TrafficPicture {
	const { index } = input;
	const active = input.flights.filter(isActive).sort((a, b) => a.id.localeCompare(b.id));
	const accesses = new Map(active.map((f) => [f.id, planAccesses(f.plan, index)]));
	const overrides = new Map(input.overrides.map((o) => [o.congestionKey, o]));
	const label = (id: string) => resourceLabel(id, index);

	// 1. Pairwise interactions from the conflict matrix.
	type Pair = { a: Flight & { plan: FlightPlan }; b: Flight & { plan: FlightPlan }; views: InteractionView[] };
	const pairs: Pair[] = [];
	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const a = active[i];
			const b = active[j];
			const found = interactions(accesses.get(a.id) ?? [], accesses.get(b.id) ?? [], index);
			if (!found.length) continue;
			pairs.push({
				a,
				b,
				views: found.map((x) => ({
					flight: a.id,
					other: b.id,
					resource: x.a.resource,
					otherResource: x.b.resource,
					mode: x.a.mode,
					otherMode: x.b.mode,
					origin: x.a.origin,
					otherOrigin: x.b.origin,
					level: x.cell.level as CongestionLevel,
					severity: x.cell.severity,
					control: x.cell.control,
					rule: x.cell.rule,
				})),
			});
		}
	}

	const flightById = new Map(active.map((f) => [f.id, f]));
	const contested = (p: Pair, side: string) =>
		new Set(p.views.filter((v) => v.control === "exclusive").map((v) => (v.flight === side ? v.resource : v.otherResource)));
	const independentWork = (f: Flight, contestedSet: Set<string>) =>
		writeResources(accesses.get(f.id) ?? []).filter((r) => !contestedSet.has(r)).length;
	const contender = (f: Flight & { plan: FlightPlan }, p: Pair): Contender => {
		const mine = contested(p, f.id);
		const contracts = p.views.some((v) => (v.flight === f.id ? v.mode : v.otherMode) === "contract" && v.control !== "caution");
		const touched = new Set(f.publishes.filter((x) => x.approved).flatMap((x) => x.touched));
		return {
			id: f.id,
			priority: f.priority,
			filedAt: f.planHistory[0]?.filedAt ?? f.plan.filedAt,
			changesContract: contracts,
			dependsOn: f.plan.dependencies,
			hasPublishedWork: [...mine].some((r) => [...touched].some((t) => isAncestorOrEqual(r, t, index) || isAncestorOrEqual(t, r, index))),
			independentWork: independentWork(f, mine),
		};
	};

	// 2. Decide each pair. Deadlock breaking may re-decide pairs with a pinned winner.
	const pinned = new Map<string, string>();
	const decidePairs = () => {
		const decisions = new Map<string, RightOfWay | undefined>();
		for (const p of pairs) {
			const key = pairKey(p.a.id, p.b.id);
			const o = overrides.get(key);
			const hasExclusive = p.views.some((v) => v.control === "exclusive");
			if (!hasExclusive) {
				decisions.set(key, undefined);
				continue;
			}
			const pin = o?.kind === "first" ? o.flightId : pinned.get(key);
			decisions.set(key, decideRightOfWay(contender(p.a, p), contender(p.b, p), pin));
		}
		return decisions;
	};

	const buildEdges = (decisions: Map<string, RightOfWay | undefined>) => {
		const edges: Edge[] = [];
		for (const p of pairs) {
			const key = pairKey(p.a.id, p.b.id);
			const o = overrides.get(key);
			if (o?.kind === "allow-both") continue;
			const row = decisions.get(key);
			if (row && o?.kind !== "hold-both") edges.push({ from: row.loser, to: row.winner, reason: `holds for ${row.winner}` });
			for (const v of p.views) {
				if (v.control !== "land-after") continue;
				const [reader, writer] = v.mode === "contract" ? [v.other, v.flight] : [v.flight, v.other];
				if (o?.kind === "first" && o.flightId === reader)
					edges.push({ from: writer, to: reader, reason: `lands after ${reader} (override)` });
				else edges.push({ from: reader, to: writer, reason: `lands after ${writer}` });
			}
		}
		for (const f of active) {
			for (const dep of f.plan.dependencies) {
				if (flightById.has(dep)) edges.push({ from: f.id, to: dep, reason: `declared dependency on ${dep}` });
			}
		}
		return edges;
	};

	let decisions = decidePairs();
	let graph = new DependencyGraph(
		active.map((f) => f.id),
		buildEdges(decisions),
	);
	const attention: AttentionItem[] = [];
	const deadlocks = graph.cycles();

	// 3. Deadlock breaking: the highest-priority, earliest-filed Flight in each cycle gets right-of-way
	//    on every contested pair inside the cycle. The break is applied automatically and flagged.
	if (deadlocks.length) {
		for (const cycle of deadlocks) {
			const pivot = [...cycle].sort((x, y) => {
				const fx = flightById.get(x);
				const fy = flightById.get(y);
				if (!fx || !fy) return 0;
				return (
					PRIORITY_RANK[fy.priority] - PRIORITY_RANK[fx.priority] ||
					(fx.planHistory[0]?.filedAt ?? 0) - (fy.planHistory[0]?.filedAt ?? 0) ||
					x.localeCompare(y)
				);
			})[0];
			for (const other of cycle) if (other !== pivot) pinned.set(pairKey(pivot, other), pivot);
			attention.push({
				id: `deadlock:${cycle.join(",")}`,
				kind: "deadlock",
				severity: "high",
				flights: cycle,
				title: `Traffic deadlock: ${cycle.join(" → ")} → ${cycle[0]}`,
				detail: `Each Flight waits on another in the cycle. Cruce gave ${pivot} right-of-way to break it; review the sequencing.`,
			});
		}
		decisions = decidePairs();
		graph = new DependencyGraph(
			active.map((f) => f.id),
			buildEdges(decisions),
		);
	}

	// 4. Congestion records with explanations.
	const congestions: Congestion[] = [];
	const held = new Map<string, HeldResource[]>();
	const landAfter = new Map<string, { flightId: string; reason: string }[]>();
	const cautions = new Map<string, string[]>();
	const pushTo = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

	for (const p of pairs) {
		const key = pairKey(p.a.id, p.b.id);
		const o = overrides.get(key);
		const row = decisions.get(key);
		const views = p.views;
		// The primary level is the category of the most severe interaction (ties: the most direct).
		const primary = [...views].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || x.level - y.level)[0];
		const level = primary.level;
		const severity = primary.severity;
		const levels = [...new Set(views.map((v) => v.level))].sort() as CongestionLevel[];
		const control: Control = views.some((v) => v.control === "exclusive")
			? "exclusive"
			: views.some((v) => v.control === "land-after")
				? "land-after"
				: "caution";
		const focus = [
			...new Set(views.map((v) => (isAncestorOrEqual(v.resource, v.otherResource, index) ? v.otherResource : v.resource))),
		].sort();

		const why: string[] = [];
		const planSteps: string[] = [];
		const fa = p.a;
		const fb = p.b;
		const name = (id: string) => `${label(id)}${parseResourceId(id).kind === "symbol" ? "()" : ""}`;

		const bothWrite = views.filter((v) => v.mode !== "read" && v.otherMode !== "read" && v.control === "exclusive");
		if (bothWrite.length) why.push(`Both intend to modify ${[...new Set(bothWrite.map((v) => name(v.resource)))].join(", ")}.`);
		for (const v of views) {
			if (v.mode === "contract" && v.control !== "caution") why.push(`${v.flight} changes the contract of ${name(v.resource)}.`);
			if (v.otherMode === "contract" && v.control !== "caution") why.push(`${v.other} changes the contract of ${name(v.otherResource)}.`);
			if (v.control === "land-after" && (v.origin === "derived" || v.otherOrigin === "derived")) {
				const reader = v.mode === "contract" ? v.other : v.flight;
				const readerRes = v.mode === "contract" ? v.otherResource : v.resource;
				why.push(`${reader}'s code imports ${label(readerRes)}, which depends on that contract.`);
			}
			if (v.control === "caution" && v.rule.includes("same file")) {
				why.push(`${name(v.resource)} and ${name(v.otherResource)} share a file but are separate airspace.`);
			}
		}
		for (const f of [fa, fb]) {
			const contractRes = views
				.filter((v) => (v.flight === f.id ? v.otherMode : v.mode) === "contract")
				.map((v) => (v.flight === f.id ? v.otherResource : v.resource));
			for (const assumption of f.plan.assumptions) {
				if (contractRes.some((r) => mentionsResource(assumption, label(r)))) why.push(`${f.id} assumes: “${assumption}”.`);
			}
		}

		if (control === "exclusive" && row && o?.kind !== "allow-both") {
			const loser = flightById.get(row.loser) as Flight & { plan: FlightPlan };
			const loserContested = contested(p, row.loser);
			const loserAll = writeResources(accesses.get(row.loser) ?? []);
			const remaining = loserAll.filter((r) => !loserContested.has(r));
			const holdBoth = o?.kind === "hold-both";
			if (holdBoth) {
				for (const side of [fa.id, fb.id]) {
					for (const r of contested(p, side)) {
						pushTo(held, side, { resource: r, waitingOn: "controller", congestionKey: key, reason: "held by a controller" });
					}
				}
				planSteps.push(`Both Flights hold ${focus.map(name).join(", ")} until a controller releases them.`);
			} else {
				for (const r of loserContested) {
					pushTo(held, row.loser, {
						resource: r,
						waitingOn: row.winner,
						congestionKey: key,
						reason: `${row.winner} has right-of-way: ${row.because[0]}`,
					});
				}
				planSteps.push(`${row.winner} receives full clearance on ${focus.map(name).join(", ")}.`);
				if (remaining.length) planSteps.push(`${row.loser} continues on ${remaining.map(name).join(", ")}.`);
				planSteps.push(`${row.loser} holds ${[...loserContested].map(name).join(", ")}.`);
				planSteps.push(`When ${row.winner} lands, ${row.loser} is refreshed onto the new baseline.`);
				if (loser) planSteps.push(`${row.loser} amends its Flight Plan; Cruce re-evaluates and issues clearance.`);
			}
		}
		if (control !== "exclusive" || o?.kind === "allow-both") {
			const la = views.filter((v) => v.control === "land-after");
			if (la.length && o?.kind !== "allow-both") {
				const v = la[0];
				const [reader, writer] = v.mode === "contract" ? [v.other, v.flight] : [v.flight, v.other];
				planSteps.push(`Both Flights proceed.`);
				planSteps.push(`${reader} lands after ${writer}, then re-validates its assumptions.`);
			} else if (o?.kind === "allow-both") {
				planSteps.push(`A controller allowed both Flights to proceed in parallel.`);
			} else {
				planSteps.push(`Both Flights proceed; the shared area is watched at landing.`);
			}
		}
		for (const v of views) {
			if (v.control === "land-after" && o?.kind !== "allow-both") {
				const [reader, writer] = v.mode === "contract" ? [v.other, v.flight] : [v.flight, v.other];
				const flipped = o?.kind === "first" && o.flightId === reader;
				const [r, w] = flipped ? [writer, reader] : [reader, writer];
				if (!(landAfter.get(r) ?? []).some((x) => x.flightId === w)) {
					pushTo(landAfter, r, { flightId: w, reason: `${w} changes a contract ${r} depends on` });
				}
			}
			if (v.control === "caution") {
				pushTo(cautions, v.flight, `${label(v.resource)} near ${v.other}'s ${label(v.otherResource)}`);
				pushTo(cautions, v.other, `${label(v.otherResource)} near ${v.flight}'s ${label(v.resource)}`);
			}
		}

		congestions.push({
			key,
			flights: [fa.id, fb.id],
			label: focus.map((r) => label(r)).join(", "),
			level,
			levels,
			severity,
			control,
			resources: focus,
			interactions: views,
			rightOfWay: o?.kind === "allow-both" || o?.kind === "hold-both" ? undefined : row,
			why: [...new Set(why)],
			plan: planSteps,
			resolution: o && o.kind !== "accept" ? "override" : "auto",
			override: o,
		});
	}

	// Level 4: semantic findings from the bounded judge. Advisory unless escalated.
	for (const s of input.semantic ?? []) {
		if (!flightById.has(s.flights[0]) || !flightById.has(s.flights[1])) continue;
		const key = pairKey(s.flights[0], s.flights[1]);
		const existing = congestions.find((c) => c.key === key);
		const note = `Semantic: ${s.summary} (${s.source}, confidence ${Math.round(s.confidence * 100)}%)`;
		if (existing) existing.why.push(note);
		else {
			congestions.push({
				key,
				flights: [...s.flights].sort() as [string, string],
				label: "Intent overlap",
				level: 4,
				levels: [4],
				severity: s.recommendation === "escalate" ? "high" : "medium",
				control: "caution",
				resources: [],
				interactions: [],
				why: [note],
				plan: [
					s.recommendation === "escalate" ? "A controller should confirm both intents are compatible." : "Both proceed; review at landing.",
				],
				resolution: s.recommendation === "escalate" ? "attention" : "auto",
			});
		}
		if (s.recommendation === "escalate") {
			attention.push({
				id: `semantic:${key}`,
				kind: "semantic",
				severity: "high",
				flights: [...s.flights],
				title: `Possible contradictory intent: ${s.flights.join(" × ")}`,
				detail: s.summary,
			});
		}
	}

	// 5. Per-Flight clearance.
	const clearances: Record<string, FlightClearance> = {};
	for (const f of active) {
		const acc = accesses.get(f.id) ?? [];
		const writes = writeResources(acc);
		const h = [...(held.get(f.id) ?? [])];
		if (f.stale) {
			for (const r of writes) {
				if (f.stale.reasons.length && !h.some((x) => x.resource === r) && staleTouches(f, r, input, index)) {
					h.push({
						resource: r,
						waitingOn: "replan",
						congestionKey: "",
						reason: `baseline changed when ${f.stale.byFlight} landed; amend the Flight Plan`,
					});
				}
			}
		}
		const heldSet = new Set(h.map((x) => x.resource));
		const cleared = writes.filter((r) => !heldSet.has(r));
		const status: ClearanceStatus = !writes.length || !h.length ? "clear" : cleared.length ? "partial" : "hold";
		clearances[f.id] = {
			flightId: f.id,
			status,
			cleared,
			held: dedupeHeld(h),
			reads: acc.filter((a) => a.mode === "read").map((a) => a.resource),
			landAfter: landAfter.get(f.id) ?? [],
			cautions: [...new Set(cautions.get(f.id) ?? [])],
		};
	}

	const occupancy: TrafficPicture["occupancy"] = {};
	for (const f of active) {
		for (const a of accesses.get(f.id) ?? []) {
			if (a.origin === "derived") continue;
			occupancy[a.resource] = [...(occupancy[a.resource] ?? []), { flightId: f.id, mode: a.mode }];
		}
	}

	return {
		congestions: congestions.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key)),
		clearances,
		edges: graph.edges(),
		deadlocks,
		landingOrder: graph.topologicalOrder(),
		attention,
		occupancy,
	};
}

/** A stale Flight re-plans the parts of its route that intersect what the landed Flight changed. */
function staleTouches(f: Flight, resource: string, input: TrafficInput, index: AirspaceIndex): boolean {
	const landed = input.flights.find((x) => x.id === f.stale?.byFlight);
	if (!landed?.plan) return true;
	const changed = planAccesses(landed.plan, index).filter((a) => a.mode !== "read" && a.origin === "declared");
	return changed.some((c) => isAncestorOrEqual(c.resource, resource, index) || isAncestorOrEqual(resource, c.resource, index));
}

/**
 * Does free-text (an assumption) refer to a resource? Matches the label, its owner, or the word
 * stems of the owner's camel-case name (`TokenValidator` ↔ "token validation").
 */
export function mentionsResource(text: string, resourceLabel: string): boolean {
	const lower = text.toLowerCase();
	const owner = resourceLabel.split(".")[0];
	if (lower.includes(resourceLabel.toLowerCase()) || lower.includes(owner.toLowerCase())) return true;
	const words = owner
		.split(/(?=[A-Z])/)
		.map((w) => w.toLowerCase().slice(0, 5))
		.filter((w) => w.length >= 4);
	return words.length > 1 && words.every((w) => lower.includes(w));
}

function dedupeHeld(h: HeldResource[]): HeldResource[] {
	const seen = new Map<string, HeldResource>();
	for (const x of h) if (!seen.has(x.resource)) seen.set(x.resource, x);
	return [...seen.values()].sort((a, b) => a.resource.localeCompare(b.resource));
}

/** Files affected by a contract change (for landing re-evaluation and the radar). */
export function contractBlastRadius(resource: string, index: AirspaceIndex): string[] {
	const p = parseResourceId(resource);
	return p.file ? dependentsOf(p.file, index) : [];
}
