import { type AirspaceIndex, ancestors, componentName, moduleLabel, moduleOfPath, parseResourceId } from "../../core/airspace.ts";
import type { ControllerState } from "../../core/controller.ts";
import { TERMINAL_PHASES } from "../../core/domain.ts";
import { planAccesses } from "../../core/traffic.ts";

export { componentName };

/** Presentation disclosure only; permissions always come from controller clearances. */
export interface GraphDisclosure {
	expandedModules: ReadonlySet<string>;
	expandedFiles: ReadonlySet<string>;
}

export type RadarNodeKind = "flight" | "module" | "component" | "symbol";

export interface RadarNode {
	id: string;
	kind: RadarNodeKind;
	label: string;
	sub?: string;
	parent?: string;
	resource?: string;
	flightId?: string;
	disclosure?: { kind: "module" | "file"; key: string; expanded: boolean };
	congestionKeys: string[];
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
	state: "cleared" | "held" | "partial" | "read" | "sequence";
	/** Every actual resource represented by an aggregated route. */
	resources: string[];
	heldResources: string[];
	clearedResources: string[];
	label?: string;
}

export interface RadarGraph {
	nodes: RadarNode[];
	edges: RadarEdge[];
	/** Resource id → most specific visible node for that resource. */
	endpoint: Record<string, string>;
	signature: string;
}

export interface Structure {
	nodes: Omit<RadarNode, "x" | "y">[];
	edges: RadarEdge[];
	endpoint: Record<string, string>;
}

const textWidth = (s: string, px = 7.1) => Math.ceil(s.length * px);
const emptyDisclosure: GraphDisclosure = { expandedModules: new Set(), expandedFiles: new Set() };

function primaryOf(path: string, index: AirspaceIndex): string | undefined {
	const name = componentName(path, index);
	return name.endsWith(".ts") ? undefined : name;
}

/** Active plans only. Contested branches stay visible; other scope expands on request. */
export function buildStructure(s: ControllerState, disclosure: GraphDisclosure = emptyDisclosure): Structure {
	const index = s.index;
	const flights = s.flights.filter((f) => !TERMINAL_PHASES.has(f.phase));
	const activeIds = new Set(flights.map((f) => f.id));
	const active = flights.filter((f) => f.plan);
	const crossings = s.traffic.congestions.filter((c) => c.control !== "caution" && c.flights.every((id) => activeIds.has(id)));
	const forced = new Set(crossings.flatMap((c) => c.resources.flatMap((r) => [r, ...ancestors(r, index)])));
	const accesses = new Map(active.map((f) => [f.id, planAccesses(f.plan!, index).filter((a) => a.origin === "declared")]));
	const routed = new Set([...accesses.values()].flatMap((items) => items.map((a) => a.resource)));
	// A dependency can identify an exact contested resource below a broader declared scope.
	for (const c of crossings) for (const r of c.resources) routed.add(r);

	const touchedFiles = new Map<string, Set<string>>();
	const touchedModules = new Set<string>();
	for (const resource of routed) {
		const p = parseResourceId(resource);
		if (p.kind === "module") {
			touchedModules.add(p.module as string);
			continue;
		}
		const file = p.file as string;
		touchedModules.add(moduleOfPath(file, index));
		const symbols = touchedFiles.get(file) ?? new Set<string>();
		if (p.kind === "symbol" && p.symbol !== primaryOf(file, index)) symbols.add(resource);
		touchedFiles.set(file, symbols);
	}

	const nodes: Structure["nodes"] = flights.map((f) => ({
		id: `flight:${f.id}`,
		kind: "flight",
		label: f.id,
		sub: f.title,
		flightId: f.id,
		width: 256,
		height: 78,
		congestionKeys: [],
	}));
	const endpoint: Record<string, string> = {};
	for (const module of [...touchedModules].sort()) {
		const moduleNode = `module:${module}`;
		const moduleResource = `m:${module}`;
		const expanded = disclosure.expandedModules.has(module);
		const files = [...touchedFiles.keys()].filter((p) => moduleOfPath(p, index) === module).sort();
		const shown = files.filter((p) => expanded || forced.has(`f:${p}`));
		endpoint[moduleResource] = moduleNode;
		nodes.push({
			id: moduleNode,
			kind: "module",
			label: moduleLabel(module, index),
			resource: moduleResource,
			sub: `${files.length} active file${files.length === 1 ? "" : "s"}`,
			disclosure: files.some((p) => !forced.has(`f:${p}`)) ? { kind: "module", key: module, expanded } : undefined,
			width: 270,
			height: 64,
			congestionKeys: [],
		});
		for (const path of files) {
			const compId = `file:${path}`;
			const fileResource = `f:${path}`;
			const name = componentName(path, index);
			const primary = primaryOf(path, index);
			const visible = shown.includes(path);
			endpoint[fileResource] = visible ? compId : moduleNode;
			if (primary) endpoint[`s:${path}#${primary}`] = endpoint[fileResource];
			const symbols = [...(touchedFiles.get(path) ?? [])].sort();
			const expandedFile = disclosure.expandedFiles.has(path);
			if (visible)
				nodes.push({
					id: compId,
					kind: "component",
					label: name,
					sub: path,
					parent: moduleNode,
					resource: fileResource,
					disclosure: symbols.some((r) => !forced.has(r)) ? { kind: "file", key: path, expanded: expandedFile } : undefined,
					width: Math.max(240, textWidth(name, 7.9) + 100),
					height: 58,
					congestionKeys: [],
				});
			for (const symbol of symbols) {
				const visibleSymbol = visible && (expandedFile || forced.has(symbol));
				endpoint[symbol] = visibleSymbol ? `sym:${symbol}` : endpoint[fileResource];
				if (!visibleSymbol) continue;
				const parts = (parseResourceId(symbol).symbol as string).split(".");
				const name = parts.length > 1 && parts[0] === primary ? parts.slice(1).join(".") : parts.join(".");
				const label = /^[A-Z]/.test(name.split(".").pop() ?? "") ? name : `${name}()`;
				nodes.push({
					id: `sym:${symbol}`,
					kind: "symbol",
					label,
					parent: compId,
					resource: symbol,
					width: Math.max(200, textWidth(label, 7.3) + 90),
					height: 34,
					congestionKeys: [],
				});
			}
		}
	}

	for (const c of crossings)
		for (const resource of c.resources) {
			const node = nodes.find((n) => n.id === resolveEndpoint(resource, endpoint, index));
			if (node && !node.congestionKeys.includes(c.key)) node.congestionKeys.push(c.key);
		}
	for (const n of nodes) {
		n.congestionKeys.sort();
		n.height += n.congestionKeys.length * 24;
	}

	const edges = new Map<string, RadarEdge>();
	const rank = { read: 0, write: 1, contract: 2 } as const;
	for (const f of active) {
		const clearance = s.traffic.clearances[f.id];
		for (const access of accesses.get(f.id) ?? []) {
			const target = resolveEndpoint(access.resource, endpoint, index);
			if (!target) continue;
			const id = `route:${f.id}:${target}`;
			const edge = edges.get(id) ?? {
				id,
				source: `flight:${f.id}`,
				target,
				flightId: f.id,
				kind: "route",
				mode: access.mode,
				state: "read",
				resources: [],
				heldResources: [],
				clearedResources: [],
			};
			if (!edge.resources.includes(access.resource)) edge.resources.push(access.resource);
			if (rank[access.mode] > rank[edge.mode]) edge.mode = access.mode;
			if (access.mode !== "read") {
				const held = clearance?.held.some((h) => h.resource === access.resource);
				const list = held ? edge.heldResources : edge.clearedResources;
				if (!list.includes(access.resource)) list.push(access.resource);
			}
			edge.state = edge.heldResources.length
				? edge.clearedResources.length
					? "partial"
					: "held"
				: edge.clearedResources.length
					? "cleared"
					: "read";
			edge.label =
				edge.state === "partial" ? `Partial · ${edge.heldResources.length} waiting` : edge.state === "held" ? "Waiting" : undefined;
			edges.set(id, edge);
		}
		const waits = new Set([...(clearance?.held ?? []).map((h) => h.waitingOn), ...(clearance?.landAfter ?? []).map((l) => l.flightId)]);
		for (const wait of waits) {
			if (!activeIds.has(wait)) continue;
			edges.set(`seq:${f.id}:${wait}`, {
				id: `seq:${f.id}:${wait}`,
				source: `flight:${f.id}`,
				target: `flight:${wait}`,
				flightId: f.id,
				kind: "sequence",
				mode: "read",
				state: "sequence",
				resources: [],
				heldResources: [],
				clearedResources: [],
				label: clearance?.held.some((h) => h.waitingOn === wait) ? "waits for" : "integrates after",
			});
		}
	}
	return { nodes, edges: [...edges.values()], endpoint };
}

function resolveEndpoint(resource: string, endpoint: Record<string, string>, index: AirspaceIndex): string | undefined {
	return (
		endpoint[resource] ??
		ancestors(resource, index)
			.map((r) => endpoint[r])
			.find(Boolean)
	);
}

let elkInstance: Promise<{ layout(graph: unknown): Promise<unknown> }> | undefined;
const elk = () => {
	elkInstance ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
	return elkInstance;
};

/** ELK runs only when visible topology changes, never for activity or clearance updates. */
export async function layout(structure: Structure): Promise<RadarGraph> {
	const children = (parent?: string) => structure.nodes.filter((n) => n.parent === parent);
	const toElk = (n: Omit<RadarNode, "x" | "y">): Record<string, unknown> => {
		const kids = children(n.id);
		const base: Record<string, unknown> = { id: n.id };
		if (n.kind === "flight")
			return { ...base, width: n.width, height: n.height, layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } };
		if (!kids.length) return { ...base, width: n.width, height: n.height };
		return {
			...base,
			children: kids.map(toElk),
			layoutOptions: {
				"elk.padding": `[top=${n.height},left=14,bottom=14,right=14]`,
				"elk.nodeSize.constraints": "MINIMUM_SIZE",
				"elk.nodeSize.minimum": `(${n.width}, ${n.height})`,
				"elk.spacing.nodeNode": n.kind === "module" ? "14" : "10",
			},
		};
	};
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.hierarchyHandling": "INCLUDE_CHILDREN",
			"elk.layered.spacing.nodeNodeBetweenLayers": "140",
			"elk.spacing.nodeNode": "26",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children: children(undefined).map(toElk),
		edges: structure.edges.filter((e) => e.kind === "route").map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	};
	type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[] };
	const result = (await (await elk()).layout(graph)) as ElkNode;
	const placed: RadarNode[] = [];
	const visit = (n: ElkNode, parent?: string) => {
		const src = structure.nodes.find((x) => x.id === n.id);
		if (src) placed.push({ ...src, parent, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? src.width, height: n.height ?? src.height });
		for (const c of n.children ?? []) visit(c, src ? n.id : undefined);
	};
	for (const c of result.children ?? []) visit(c);
	return { nodes: placed, edges: structure.edges, endpoint: structure.endpoint, signature: signatureOf(structure) };
}

export function signatureOf(structure: Structure): string {
	return [
		structure.nodes.map((n) => `${n.id}@${n.parent ?? ""}:${n.width}x${n.height}`).join(","),
		structure.edges
			.filter((e) => e.kind === "route")
			.map((e) => `${e.source}>${e.target}`)
			.join(","),
	].join("|");
}
