import { type AirspaceIndex, moduleLabel, parseResourceId, resourceLabel } from "../core/airspace.ts";
import type { ControllerState, TowerEvent } from "../core/controller.ts";
import { type Flight, TERMINAL_PHASES } from "../core/domain.ts";
import { type Congestion, type FlightClearance, planAccesses } from "../core/traffic.ts";
import { componentName } from "./radar/graph.ts";

/** Presentation only. All permissions and decisions come from the controller. */
export type Tone = "working" | "clear" | "partial" | "caution" | "hold" | "collision" | "landed" | "muted";
export interface FlightBadge {
	label: string;
	tone: Tone;
	detail?: string;
}
export const isActive = (f: Flight) => !TERMINAL_PHASES.has(f.phase);
export const short = (sha?: string) => (sha ? sha.slice(0, 7) : "—");
export const taskName = (s: ControllerState, id: string) => s.flights.find((f) => f.id === id)?.title ?? id;
export const attentionItems = (s: ControllerState) => [...new Map([...s.attention, ...s.traffic.attention].map((a) => [a.id, a])).values()];

export function flightBadge(f: Flight, c?: FlightClearance, s?: ControllerState): FlightBadge {
	if (f.phase === "landed") return { label: "Done", tone: "landed", detail: "Integrated into main" };
	if (f.phase === "cancelled") return { label: "Cancelled", tone: "muted" };
	if (f.phase === "failed" || f.phase === "lost")
		return { label: "Failed", tone: "collision", detail: f.failureReason ?? "Agent stopped responding" };
	if (s && attentionItems(s).some((a) => a.flights.includes(f.id))) return { label: "Needs attention", tone: "collision" };
	if (f.stale)
		return {
			label: "Planning",
			tone: "caution",
			detail: `Updating plan after ${s ? taskName(s, f.stale.byFlight) : f.stale.byFlight} completed`,
		};
	if (c?.status === "hold") return { label: "Waiting", tone: "caution", detail: "Waiting for clearance" };
	if (["landing", "validating", "publishing"].includes(f.phase))
		return {
			label: "Checking",
			tone: "working",
			detail: f.phase === "landing" ? "Checking integration" : f.phase === "validating" ? "Running validation" : "Publishing changes",
		};
	if (!f.plan)
		return f.phase === "discovery"
			? { label: "Exploring", tone: "working", detail: "Reading the repository" }
			: { label: "Waiting", tone: "muted", detail: f.phase === "queued" ? "Queued" : "Preparing workspace" };
	return {
		label: "Working",
		tone: "working",
		detail: c?.held.length ? `Waiting on ${c.held.map((h) => (s ? label(h.resource, s.index) : h.resource)).join(", ")}` : undefined,
	};
}

export function counts(s: ControllerState) {
	const overlaps = s.traffic.congestions.filter((c) => c.control !== "caution");
	return {
		active: s.flights.filter(isActive).length,
		congestion: overlaps.length,
		overlapping: new Set(overlaps.flatMap((c) => c.flights)).size,
		automatic: overlaps.filter((c) => c.resolution === "auto" && !c.override && !congestionNeedsDecision(c, s)).length,
		attention: attentionItems(s).length,
		landed: s.flights.filter((f) => f.phase === "landed").length,
		holds: Object.values(s.traffic.clearances).reduce((n, c) => n + c.held.length, 0),
	};
}

export function label(id: string, index: AirspaceIndex): string {
	const p = parseResourceId(id);
	if (p.kind === "file" && p.file) return componentName(p.file, index);
	const l = resourceLabel(id, index);
	return p.kind === "symbol" && !/^[A-Z]/.test(l.split(".").pop() ?? "") ? `${l}()` : l;
}

export interface RouteEntry {
	resource: string;
	label: string;
	mode: "read" | "write" | "contract";
	origin: "declared" | "derived";
	state: "cleared" | "held" | "read";
	reason?: string;
}
export function routeOf(f: Flight, s: ControllerState): { module: string; entries: RouteEntry[] }[] {
	if (!f.plan) return [];
	const c = s.traffic.clearances[f.id];
	const groups = new Map<string, RouteEntry[]>();
	for (const a of planAccesses(f.plan, s.index)) {
		if (a.origin === "derived") continue;
		const p = parseResourceId(a.resource);
		const mod = p.module ?? s.index.files.find((x) => x.path === p.file)?.module ?? "root";
		const held = c?.held.find((h) => h.resource === a.resource);
		const entry: RouteEntry = {
			resource: a.resource,
			label: label(a.resource, s.index),
			mode: a.mode,
			origin: a.origin,
			state: a.mode === "read" ? "read" : held ? "held" : "cleared",
			reason: held?.reason,
		};
		groups.set(mod, [...(groups.get(mod) ?? []), entry]);
	}
	return [...groups].map(([module, entries]) => ({ module: moduleLabel(module, s.index), entries }));
}

export const congestionFor = (s: ControllerState, id: string) => s.traffic.congestions.filter((c) => c.flights.includes(id));
export const missionOf = (s: ControllerState, f: Flight) => s.missions.find((m) => m.id === f.missionId);
export const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const LEVEL_NAMES: Record<number, string> = {
	1: "Structural overlap",
	2: "Dependency",
	3: "Contract change",
	4: "Semantic check",
	5: "Git conflict",
};
export function agentName(f: Flight) {
	return f.agent === "mock" ? "Demo agent" : f.agentRuntime.split(" · ")[0];
}
export function scopeOf(f: Flight, s: ControllerState) {
	return [
		...new Set(
			routeOf(f, s)
				.flatMap((g) => g.entries)
				.filter((e) => e.mode !== "read")
				.map((e) => (parseResourceId(e.resource).kind === "symbol" ? e.label.split(".")[0] : e.label)),
		),
	];
}
export function congestionNeedsDecision(c: Congestion, s?: ControllerState) {
	return (
		c.resolution === "attention" ||
		(!!s && attentionItems(s).some((a) => a.kind === "semantic" && c.flights.every((id) => a.flights.includes(id))))
	);
}
export function decisionLabel(c: Congestion, s?: ControllerState) {
	if (congestionNeedsDecision(c, s)) return "Needs a decision";
	if (c.override || c.resolution === "override") return "Human override";
	return c.control === "caution" ? "No action needed" : "Handled automatically";
}
export function friendlyText(text: string, s: ControllerState) {
	return text
		.replace(/\bF-\d+\b/g, (id) => taskName(s, id))
		.replace(/Flight Plans?/gi, "plan")
		.replace(/\bFlights?\b/g, "run")
		.replace(/\bMissions?\b/g, "task")
		.replace(/\bairspace\b/gi, "scope")
		.replace(/\blands\b/g, "is integrated")
		.replace(/\blanded\b/gi, "integrated")
		.replace(/\blanding\b/gi, "integration")
		.replace(/\bcanonical\b/gi, "main")
		.replace(/\bright-of-way\b/g, "priority here");
}
export function eventText(e: TowerEvent, s: ControllerState) {
	const f = e.flightId ? taskName(s, e.flightId) : "";
	switch (e.type) {
		case "mission.created":
			return "Task created";
		case "flight.created":
			return "Agent run created";
		case "plan.filed":
			return "Plan ready · Cruce checked current work";
		case "plan.amended":
			return "Plan updated · coordination rechecked";
		case "flight.stale":
			return "Baseline changed · updating the plan";
		case "baseline.refreshed":
			return "Workspace refreshed against main";
		case "flight.landed":
			return `${f ? `${f} · ` : ""}Integrated into main`;
		case "publish.approved":
			return "Changes approved within clearance";
		case "publish.rejected":
			return "Changes outside clearance · amendment needed";
		case "congestion.cleared":
			return "Overlap resolved";
		case "lease.yielded":
			return "Shared scope yielded to another task";
		default:
			return friendlyText(e.title, s)
				.replace(/\bCLEAR\b/g, "Cleared")
				.replace(/\bPARTIAL CLEARANCE\b/g, "Independent work can continue")
				.replace(/\bHOLD\b/g, "Waiting")
				.replace(/\bDISCOVERY\b/g, "Exploring")
				.replace(/\bPROVISIONING\b/g, "Preparing workspace");
	}
}
