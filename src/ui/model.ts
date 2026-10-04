import { type AirspaceIndex, moduleLabel, parseResourceId, resourceLabel } from "../core/airspace.ts";
import type { ControllerState } from "../core/controller.ts";
import { type Flight, TERMINAL_PHASES } from "../core/domain.ts";
import type { Congestion, FlightClearance } from "../core/traffic.ts";
import { planAccesses } from "../core/traffic.ts";
import { componentName } from "./radar/graph.ts";

/** Pure derivations from controller state for display. The UI never re-decides anything. */

export type Tone = "clear" | "partial" | "caution" | "hold" | "collision" | "landed" | "muted";

export interface FlightBadge {
	label: string;
	tone: Tone;
}

export function flightBadge(f: Flight, c?: FlightClearance): FlightBadge {
	switch (f.phase) {
		case "landed":
			return { label: "LANDED", tone: "landed" };
		case "failed":
			return { label: "FAILED", tone: "collision" };
		case "lost":
			return { label: "LOST", tone: "collision" };
		case "cancelled":
			return { label: "CANCELLED", tone: "muted" };
		case "queued":
		case "provisioning":
		case "discovery":
			if (!f.plan) return { label: f.phase === "discovery" ? "DISCOVERY" : f.phase.toUpperCase(), tone: "muted" };
	}
	if (f.stale) return { label: "STALE", tone: "caution" };
	if (f.phase === "landing") return { label: "LANDING", tone: "clear" };
	switch (c?.status) {
		case "clear":
			return { label: "CLEAR", tone: "clear" };
		case "partial":
			return { label: "PARTIAL", tone: "partial" };
		case "hold":
			return { label: "HOLD", tone: "hold" };
		default:
			return { label: "—", tone: "muted" };
	}
}

export const isActive = (f: Flight) => !TERMINAL_PHASES.has(f.phase);

export interface TrafficCounts {
	active: number;
	congestion: number;
	holds: number;
	attention: number;
	landed: number;
}

export function counts(s: ControllerState): TrafficCounts {
	const active = s.flights.filter(isActive);
	return {
		active: active.length,
		congestion: s.traffic.congestions.filter((c) => c.control !== "caution").length,
		holds: Object.values(s.traffic.clearances).reduce((n, c) => n + c.held.length, 0),
		attention: s.attention.length + s.traffic.attention.length,
		landed: s.flights.filter((f) => f.phase === "landed").length,
	};
}

export const short = (sha?: string) => (sha ? sha.slice(0, 7) : "—");

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

/** A Flight's route grouped by module, with the clearance state of every segment. */
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
	return [...groups.entries()].map(([module, entries]) => ({ module: moduleLabel(module, s.index), entries }));
}

export function congestionFor(s: ControllerState, flightId: string): Congestion[] {
	return s.traffic.congestions.filter((c) => c.flights.includes(flightId));
}

export function missionOf(s: ControllerState, f: Flight) {
	return s.missions.find((m) => m.id === f.missionId);
}

export function timeOf(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export const LEVEL_NAMES: Record<number, string> = { 1: "structural", 2: "dependency", 3: "contract", 4: "semantic", 5: "git" };
