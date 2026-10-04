import ELK from "elkjs/lib/elk.bundled.js";
import type { AirspaceIndex } from "../../core/airspace.ts";
import { componentName, moduleLabel, parseResourceId } from "../../core/airspace.ts";

export { componentName };

import type { ControllerState } from "../../core/controller.ts";
import { planAccesses } from "../../core/traffic.ts";
import { isActive } from "../model.ts";

/**
 * Builds the radar's airspace graph with progressive resolution:
 *
 *   module  →  component (file / primary type)  →  symbol
 *
 * Only airspace on an active route is expanded; everything else collapses into quiet modules.
 * Positions come from ELK (layered, left → right): Flights on the left, airspace to the right.
 */

export type RadarNodeKind = "flight" | "module" | "component" | "symbol" | "quiet";

export interface RadarNode {
	id: string;
	kind: RadarNodeKind;
	label: string;
	sub?: string;
	parent?: string;
	resource?: string;
	flightId?: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RadarEdge {
	id: string;
	source: string;
	target: string;
	flightId: string;
	kind: "route" | "sequence";
	mode: "read" | "write" | "contract";
	state: "cleared" | "held" | "read" | "sequence" | "landed";
	resource?: string;
	label?: string;
}

export interface RadarGraph {
	nodes: RadarNode[];
	edges: RadarEdge[];
	/** resource id → radar node id (the most specific visible node for that resource). */
	endpoint: Record<string, string>;
	signature: string;
}

const textWidth = (s: string, px = 7.1) => Math.ceil(s.length * px);

function primaryOf(path: string, index: AirspaceIndex): string | undefined {
	const name = componentName(path, index);
	return name.endsWith(".ts") ? undefined : name;
}

interface Structure {
	nodes: Omit<RadarNode, "x" | "y">[];
	edges: RadarEdge[];
	endpoint: Record<string, string>;
	quiet: Omit<RadarNode, "x" | "y">[];
}

export function buildStructure(s: ControllerState): Structure {
	const index = s.index;
	const flights = s.flights;
	const active = flights.filter((f) => f.plan && isActive(f));
	// Landed Flights keep a faint trace of their route, so the map stays stable as traffic lands.
	const traced = flights.filter((f) => f.plan && (isActive(f) || f.phase === "landed"));
	const routed = new Set<string>();
	for (const f of traced)
		for (const a of planAccesses(f.plan!, index)) if (a.origin === "declared" && a.mode !== "read") routed.add(a.resource);
	for (const f of active) for (const a of planAccesses(f.plan!, index)) if (a.origin === "declared") routed.add(a.resource);

	const nodes: Omit<RadarNode, "x" | "y">[] = [];
	const endpoint: Record<string, string> = {};

	for (const f of flights) {
		nodes.push({ id: `flight:${f.id}`, kind: "flight", label: f.id, sub: f.title, flightId: f.id, width: 236, height: 70 });
	}

	// Which modules / files / symbols does any route touch?
	const touchedFiles = new Map<string, Set<string>>(); // file → symbol resource ids
	const touchedModules = new Set<string>();
	for (const r of routed) {
		const p = parseResourceId(r);
		if (p.kind === "module") {
			touchedModules.add(p.module as string);
			continue;
		}
		const file = p.file as string;
		const mod =
			index.files.find((f) => f.path === file)?.module ?? index.modules.find((m) => m.paths.some((x) => file.startsWith(x)))?.id ?? "root";
		touchedModules.add(mod);
		const set = touchedFiles.get(file) ?? new Set<string>();
		if (p.kind === "symbol") {
			const top = (p.symbol as string).split(".")[0];
			const isPrimary = !(p.symbol as string).includes(".") && top === primaryOf(file, index);
			if (!isPrimary) set.add(r);
		}
		touchedFiles.set(file, set);
	}

	const occupancy = new Map<string, number>();
	for (const f of active) {
		for (const a of planAccesses(f.plan!, index))
			if (a.origin === "declared") occupancy.set(a.resource, (occupancy.get(a.resource) ?? 0) + 1);
	}
	const tags = (ids: string[]) =>
		Math.min(
			4,
			ids.reduce((n, id) => n + (occupancy.get(id) ?? 0), 0),
		) * 27;
	const quiet: Omit<RadarNode, "x" | "y">[] = [];
	for (const m of index.modules) {
		const moduleNode = `module:${m.id}`;
		endpoint[`m:${m.id}`] = moduleNode;
		const files = index.files.filter((f) => f.module === m.id);
		if (!touchedModules.has(m.id)) {
			const lbl = moduleLabel(m.id, index);
			quiet.push({
				id: moduleNode,
				kind: "quiet",
				label: lbl,
				sub: `${files.length} file${files.length === 1 ? "" : "s"}`,
				width: Math.max(150, textWidth(lbl, 7.6) + 70),
				height: 34,
			});
			continue;
		}
		const shown = [...touchedFiles.keys()].filter(
			(p) =>
				(index.files.find((f) => f.path === p)?.module ?? "root") === m.id ||
				(!index.files.some((f) => f.path === p) && m.paths.some((x) => p.startsWith(x))),
		);
		const hidden = files.length - shown.filter((p) => index.files.some((f) => f.path === p)).length;
		nodes.push({
			id: moduleNode,
			kind: "module",
			label: moduleLabel(m.id, index),
			sub: hidden > 0 ? `+${hidden} quiet` : undefined,
			width: 0,
			height: 0,
		});
		for (const path of shown.sort()) {
			const compId = `file:${path}`;
			endpoint[`f:${path}`] = compId;
			const name = componentName(path, index);
			const primary = primaryOf(path, index);
			if (primary) endpoint[`s:${path}#${primary}`] = compId;
			const symbols = [...(touchedFiles.get(path) ?? [])].sort();
			nodes.push({
				id: compId,
				kind: "component",
				label: name,
				sub: path,
				parent: moduleNode,
				resource: `f:${path}`,
				width: Math.max(176, textWidth(name, 7.9) + 40 + tags([`f:${path}`, ...(primary ? [`s:${path}#${primary}`] : [])])),
				height: 40,
			});
			for (const sym of symbols) {
				const symName = parseResourceId(sym).symbol as string;
				const parts = symName.split(".");
				const shownName = parts.length > 1 && parts[0] === primary ? parts.slice(1).join(".") : symName;
				const lbl = /^[A-Z]/.test(shownName.split(".").pop() ?? "") ? shownName : `${shownName}()`;
				const id = `sym:${sym}`;
				endpoint[sym] = id;
				nodes.push({
					id,
					kind: "symbol",
					label: lbl,
					parent: compId,
					resource: sym,
					width: Math.max(120, textWidth(lbl, 7.3) + 30 + tags([sym])),
					height: 26,
				});
			}
		}
	}

	// Routes: one edge per (flight, endpoint), strongest access wins.
	const edges = new Map<string, RadarEdge>();
	const rank = { read: 0, write: 1, contract: 2 } as const;
	for (const f of traced) {
		const c = s.traffic.clearances[f.id];
		const landed = f.phase === "landed";
		for (const a of planAccesses(f.plan!, index)) {
			if (a.origin === "derived" || (landed && a.mode === "read")) continue;
			const target = resolveEndpoint(a.resource, endpoint, index);
			if (!target) continue;
			const id = `route:${f.id}:${target}`;
			const held = c?.held.some((h) => h.resource === a.resource);
			const edge: RadarEdge = {
				id,
				source: `flight:${f.id}`,
				target,
				flightId: f.id,
				kind: "route",
				mode: a.mode,
				state: landed ? "landed" : a.mode === "read" ? "read" : held ? "held" : "cleared",
				resource: a.resource,
			};
			const prev = edges.get(id);
			if (!prev || rank[a.mode] > rank[prev.mode] || (edge.state === "held" && prev.state !== "held")) edges.set(id, edge);
		}
	}

	// Sequencing between Flights: who holds for whom.
	for (const f of active) {
		const c = s.traffic.clearances[f.id];
		const waits = new Set([...(c?.held ?? []).map((h) => h.waitingOn), ...(c?.landAfter ?? []).map((l) => l.flightId)]);
		for (const w of waits) {
			if (!flights.some((x) => x.id === w)) continue;
			edges.set(`seq:${f.id}:${w}`, {
				id: `seq:${f.id}:${w}`,
				source: `flight:${f.id}`,
				target: `flight:${w}`,
				flightId: f.id,
				kind: "sequence",
				mode: "read",
				state: "sequence",
				label: c?.held.some((h) => h.waitingOn === w) ? "holds for" : "lands after",
			});
		}
	}

	return { nodes, edges: [...edges.values()], endpoint, quiet };
}

function resolveEndpoint(resource: string, endpoint: Record<string, string>, index: AirspaceIndex): string | undefined {
	if (endpoint[resource]) return endpoint[resource];
	const p = parseResourceId(resource);
	if (p.kind === "symbol") {
		const parts = (p.symbol as string).split(".");
		for (let i = parts.length - 1; i > 0; i--) {
			const up = `s:${p.file}#${parts.slice(0, i).join(".")}`;
			if (endpoint[up]) return endpoint[up];
		}
		return endpoint[`f:${p.file}`];
	}
	if (p.kind === "file") return endpoint[resource] ?? endpoint[`m:${index.files.find((f) => f.path === p.file)?.module ?? "root"}`];
	return endpoint[resource];
}

const elk = new ELK();

/** Run ELK and flatten to absolute-in-parent coordinates for React Flow. */
export async function layout(structure: Structure): Promise<RadarGraph> {
	const children = (parent?: string) => structure.nodes.filter((n) => n.parent === parent);
	const toElk = (n: Omit<RadarNode, "x" | "y">): Record<string, unknown> => {
		const kids = children(n.id);
		const base: Record<string, unknown> = { id: n.id };
		if (n.kind === "flight") {
			return { ...base, width: n.width, height: n.height, layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } };
		}
		if (!kids.length) return { ...base, width: n.width, height: n.height };
		return {
			...base,
			children: kids.map(toElk),
			layoutOptions: {
				"elk.padding": n.kind === "module" ? "[top=36,left=14,bottom=14,right=14]" : "[top=40,left=12,bottom=10,right=12]",
				"elk.nodeSize.constraints": "MINIMUM_SIZE",
				"elk.nodeSize.minimum": `(${n.width || 200}, ${n.height || 60})`,
				"elk.spacing.nodeNode": n.kind === "module" ? "14" : "8",
			},
		};
	};
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.hierarchyHandling": "INCLUDE_CHILDREN",
			"elk.layered.spacing.nodeNodeBetweenLayers": "110",
			"elk.spacing.nodeNode": "22",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children: children(undefined).map(toElk),
		edges: structure.edges.filter((e) => e.kind === "route").map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	};
	type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[] };
	const result = (await elk.layout(graph as never)) as unknown as ElkNode;
	const placed: RadarNode[] = [];
	const visit = (n: ElkNode, parent?: string) => {
		const src = structure.nodes.find((x) => x.id === n.id);
		if (src) placed.push({ ...src, parent, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? src.width, height: n.height ?? src.height });
		for (const c of n.children ?? []) visit(c, src ? n.id : undefined);
	};
	for (const c of result.children ?? []) visit(c);

	// Quiet airspace sits in a row under the active map.
	const bottom = Math.max(0, ...placed.filter((n) => !n.parent).map((n) => n.y + n.height));
	const left = Math.min(...placed.filter((n) => n.kind !== "flight" && !n.parent).map((n) => n.x), 400);
	let x = Number.isFinite(left) ? left : 400;
	for (const q of structure.quiet) {
		placed.push({ ...q, x, y: bottom + 44 });
		x += q.width + 14;
	}
	return { nodes: placed, edges: structure.edges, endpoint: structure.endpoint, signature: signatureOf(structure) };
}

export function signatureOf(structure: Structure): string {
	return [
		structure.nodes.map((n) => `${n.id}@${n.parent ?? ""}`).join(","),
		structure.quiet.map((n) => n.id).join(","),
		structure.edges
			.filter((e) => e.kind === "route")
			.map((e) => `${e.source}>${e.target}`)
			.join(","),
	].join("|");
}
