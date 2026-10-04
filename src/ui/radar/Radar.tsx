import {
	Background,
	BaseEdge,
	type Edge,
	type EdgeProps,
	getBezierPath,
	Handle,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ControllerState } from "../../core/controller.ts";
import { flightBadge, type Tone } from "../model.ts";
import { buildStructure, layout, type RadarEdge, type RadarGraph, type RadarNode, signatureOf } from "./graph.ts";

export type Selection = { kind: "flight"; id: string } | { kind: "congestion"; key: string } | { kind: "resource"; id: string } | null;

interface Props {
	state: ControllerState;
	selection: Selection;
	hover: string | null;
	onSelect(sel: Selection): void;
	onHover(flightId: string | null): void;
}

interface NodeData extends Record<string, unknown> {
	node: RadarNode;
	tone?: Tone;
	badge?: string;
	phase?: string;
	activity?: string;
	dim: boolean;
	focus: boolean;
	conflict?: { key: string; flights: string[]; severity: string };
	occupants: { flightId: string; state: string }[];
}

interface EdgeData extends Record<string, unknown> {
	edge: RadarEdge;
	dim: boolean;
	focus: boolean;
}

const FlightNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className={`rn-flight tone-${data.tone} ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""}`}>
		<Handle type="target" position={Position.Left} id="seq-in" className="h-hidden" />
		<Handle type="source" position={Position.Left} id="seq-out" className="h-hidden" />
		<div className="rn-flight-top">
			<span className="rn-flight-id">{data.node.label}</span>
			<span className={`chip tone-${data.tone}`}>{data.badge}</span>
		</div>
		<div className="rn-flight-title">{data.node.sub}</div>
		<div className="rn-flight-phase">{data.activity ?? data.phase}</div>
		<Handle type="source" position={Position.Right} id="route-out" className="h-hidden" />
	</div>
));

const ModuleNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className={`rn-module ${data.dim ? "dim" : ""} ${data.conflict ? "has-conflict" : ""}`}>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<div className="rn-module-label">
			{data.node.label}
			{data.node.sub && <span className="rn-module-sub">{data.node.sub}</span>}
		</div>
	</div>
));

const QuietNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className="rn-quiet">
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<span>{data.node.label}</span>
		<span className="rn-quiet-sub">{data.node.sub}</span>
	</div>
));

function Occupants({ list }: { list: NodeData["occupants"] }) {
	if (!list.length) return null;
	return (
		<span className="rn-occ">
			{list.map((o) => (
				<span key={o.flightId} className={`rn-occ-tag st-${o.state}`}>
					{o.flightId.replace("F-", "")}
				</span>
			))}
		</span>
	);
}

const ComponentNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div
		className={`rn-component ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""} ${data.conflict ? `conflict sev-${data.conflict.severity}` : ""}`}
	>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<div className="rn-component-head">
			<span className="rn-component-label">{data.node.label}</span>
			<Occupants list={data.occupants} />
		</div>
		{data.conflict && <div className="rn-conflict-tag">{data.conflict.flights.join(" × ")}</div>}
	</div>
));

const SymbolNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div
		className={`rn-symbol ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""} ${data.conflict ? `conflict sev-${data.conflict.severity}` : ""}`}
	>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<span className="rn-symbol-label">{data.node.label}</span>
		<Occupants list={data.occupants} />
	</div>
));

function RouteEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<EdgeData>>) {
	const e = data?.edge;
	if (!e) return null;
	if (e.kind === "sequence") {
		const bend = 54;
		const path = `M ${sourceX} ${sourceY} C ${sourceX - bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`;
		return (
			<g className={`re-seq ${data.dim ? "dim" : ""}`}>
				<BaseEdge id={id} path={path} />
				<text x={Math.min(sourceX, targetX) - bend + 4} y={(sourceY + targetY) / 2} className="re-seq-label" textAnchor="end">
					{e.label}
				</text>
			</g>
		);
	}
	const [path, lx, ly] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		curvature: 0.32,
	});
	return (
		<g className={`re re-${e.mode} re-${e.state} ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""}`}>
			<BaseEdge id={id} path={path} />
			{e.state === "held" && (
				<g transform={`translate(${lx}, ${ly})`} className="re-hold-tag">
					<rect x={-19} y={-9} width={38} height={18} rx={4} />
					<text textAnchor="middle" y={4}>
						HOLD
					</text>
				</g>
			)}
		</g>
	);
}

const nodeTypes = { flight: FlightNode, module: ModuleNode, component: ComponentNode, symbol: SymbolNode, quiet: QuietNode };
const edgeTypes = { route: RouteEdgeView };

export function Radar({ state, selection, hover, onSelect, onHover }: Props) {
	const structure = useMemo(() => buildStructure(state), [state]);
	const signature = useMemo(() => signatureOf(structure), [structure]);
	const [graph, setGraph] = useState<RadarGraph | null>(null);
	const flow = useRef<ReactFlowInstance<Node<NodeData>, Edge<EdgeData>> | null>(null);
	const lastFit = useRef("");

	// Re-layout only when the structure changes; statuses update in place.
	// biome-ignore lint/correctness/useExhaustiveDependencies: signature captures structure.
	useEffect(() => {
		let cancelled = false;
		layout(structure).then((g) => !cancelled && setGraph(g));
		return () => {
			cancelled = true;
		};
	}, [signature]);

	const focusFlight = hover ?? (selection?.kind === "flight" ? selection.id : null);
	const focusCongestion = selection?.kind === "congestion" ? state.traffic.congestions.find((c) => c.key === selection.key) : undefined;

	const { nodes, edges } = useMemo(() => {
		if (!graph) return { nodes: [] as Node<NodeData>[], edges: [] as Edge<EdgeData>[] };
		const liveEdges = structure.edges;
		const focusFlights = new Set(focusCongestion ? focusCongestion.flights : focusFlight ? [focusFlight] : []);
		const related = new Set<string>();
		for (const e of liveEdges) {
			if (!focusFlights.has(e.flightId)) continue;
			related.add(e.source);
			related.add(e.target);
		}
		const parents = new Map(graph.nodes.map((n) => [n.id, n.parent]));
		for (const id of [...related]) {
			let p = parents.get(id);
			while (p) {
				related.add(p);
				p = parents.get(p);
			}
		}
		const occupants = new Map<string, NodeData["occupants"]>();
		for (const e of liveEdges) {
			if (e.kind !== "route" || e.state === "landed") continue;
			occupants.set(e.target, [...(occupants.get(e.target) ?? []), { flightId: e.flightId, state: e.state }]);
		}
		const conflicts = new Map<string, NonNullable<NodeData["conflict"]>>();
		for (const c of state.traffic.congestions) {
			if (c.control === "caution") continue;
			for (const r of c.resources) {
				const node = graph.endpoint[r] ?? structure.endpoint[r];
				if (node) conflicts.set(node, { key: c.key, flights: c.flights, severity: c.severity });
			}
		}
		const anyFocus = focusFlights.size > 0;
		const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
			const f = n.flightId ? state.flights.find((x) => x.id === n.flightId) : undefined;
			const badge = f ? flightBadge(f, state.traffic.clearances[f.id]) : undefined;
			const isLanded = f && ["landed", "cancelled", "failed", "lost"].includes(f.phase);
			const plan = f?.plan ? ` · plan v${f.plan.planVersion}` : "";
			return {
				id: n.id,
				type: n.kind,
				position: { x: n.x, y: n.y },
				parentId: n.parent,
				draggable: false,
				selectable: true,
				style: { width: n.width, height: n.height },
				zIndex: n.kind === "flight" ? 20 : undefined,
				data: {
					node: n,
					tone: badge?.tone,
					badge: badge?.label,
					phase: f ? `${f.phase}${plan}` : undefined,
					activity: f && !isLanded && f.activity ? f.activity.text : f?.landedCommit ? `landed · ${f.landedCommit.slice(0, 7)}` : undefined,
					dim: anyFocus ? !related.has(n.id) && !(n.flightId && focusFlights.has(n.flightId)) : !!isLanded,
					focus: anyFocus && (related.has(n.id) || (!!n.flightId && focusFlights.has(n.flightId))),
					conflict: conflicts.get(n.id),
					occupants: occupants.get(n.id) ?? [],
				},
			};
		});
		const edges: Edge<EdgeData>[] = liveEdges
			.filter((e) => graph.nodes.some((n) => n.id === e.source) && graph.nodes.some((n) => n.id === e.target))
			// Read routes are context, not traffic: shown only for the Flight in focus.
			.filter((e) => e.state !== "read" || focusFlights.has(e.flightId))
			.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				sourceHandle: e.kind === "sequence" ? "seq-out" : "route-out",
				targetHandle: e.kind === "sequence" ? "seq-in" : undefined,
				type: "route",
				selectable: false,
				data: { edge: e, dim: anyFocus && !focusFlights.has(e.flightId), focus: anyFocus && focusFlights.has(e.flightId) },
			}));
		return { nodes, edges };
	}, [graph, structure, state, focusFlight, focusCongestion]);

	// Fit the whole airspace whenever its structure changes (bounds are known from the layout).
	useEffect(() => {
		if (!graph || !flow.current || lastFit.current === graph.signature) return;
		lastFit.current = graph.signature;
		const abs = absolutePositions(graph.nodes);
		const xs = graph.nodes.filter((n) => !n.parent).flatMap((n) => [abs[n.id].x, abs[n.id].x + n.width]);
		const ys = graph.nodes.filter((n) => !n.parent).flatMap((n) => [abs[n.id].y, abs[n.id].y + n.height]);
		if (!xs.length) return;
		const bounds = {
			x: Math.min(...xs) - 90,
			y: Math.min(...ys) - 20,
			width: Math.max(...xs) - Math.min(...xs) + 110,
			height: Math.max(...ys) - Math.min(...ys) + 70,
		};
		requestAnimationFrame(() => flow.current?.fitBounds(bounds, { padding: 0.06, duration: 450 }));
	}, [graph]);

	return (
		<div className="radar">
			<ReactFlow<Node<NodeData>, Edge<EdgeData>>
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onInit={(i) => {
					flow.current = i;
				}}
				onNodeClick={(_, n) => {
					const d = n.data;
					if (d.node.kind === "flight" && d.node.flightId) onSelect({ kind: "flight", id: d.node.flightId });
					else if (d.conflict) onSelect({ kind: "congestion", key: d.conflict.key });
					else if (d.node.resource) onSelect({ kind: "resource", id: d.node.resource });
				}}
				onNodeMouseEnter={(_, n) => n.data.node.flightId && onHover(n.data.node.flightId)}
				onNodeMouseLeave={() => onHover(null)}
				onPaneClick={() => onSelect(null)}
				nodesDraggable={false}
				nodesConnectable={false}
				proOptions={{ hideAttribution: true }}
				minZoom={0.3}
				maxZoom={2}
				fitView
			>
				<Background gap={28} size={1} color="var(--grid)" />
			</ReactFlow>
			{state.flights.length === 0 && (
				<div className="radar-empty">
					<div className="radar-empty-title">No traffic</div>
					<div className="radar-empty-sub">Delegate Missions to see Flights, their routes, and where they intersect.</div>
				</div>
			)}
		</div>
	);
}

function absolutePositions(nodes: RadarNode[]): Record<string, { x: number; y: number }> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out: Record<string, { x: number; y: number }> = {};
	const resolve = (n: RadarNode): { x: number; y: number } => {
		if (out[n.id]) return out[n.id];
		const parent = n.parent ? byId.get(n.parent) : undefined;
		const base = parent ? resolve(parent) : { x: 0, y: 0 };
		out[n.id] = { x: base.x + n.x, y: base.y + n.y };
		return out[n.id];
	};
	for (const n of nodes) resolve(n);
	return out;
}
