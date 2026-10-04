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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControllerState } from "../../core/controller.ts";
import { flightBadge, type Tone } from "../model.ts";
import { buildStructure, type GraphDisclosure, layout, type RadarEdge, type RadarGraph, type RadarNode, signatureOf } from "./graph.ts";

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
	activity?: string;
	dim: boolean;
	focus: boolean;
	crossings: { key: string; flights: string[] }[];
	occupants: { flightId: string; state: string }[];
	onDisclosure(disclosure: NonNullable<RadarNode["disclosure"]>): void;
	onCrossing(key: string): void;
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
		<div className="rn-flight-phase">{data.activity}</div>
		<Handle type="source" position={Position.Right} id="route-out" className="h-hidden" />
	</div>
));

function Disclosure({ data }: { data: NodeData }) {
	const disclosure = data.node.disclosure;
	if (!disclosure) return null;
	const what = disclosure.kind === "module" ? "files" : "symbols";
	return (
		<button
			type="button"
			className="rn-disclosure nodrag nopan"
			aria-expanded={disclosure.expanded}
			aria-label={`${disclosure.expanded ? "Collapse" : "Expand"} ${what} in ${data.node.label}`}
			onClick={(event) => {
				event.stopPropagation();
				data.onDisclosure(disclosure);
			}}
		>
			{disclosure.expanded ? "−" : "+"} {what}
		</button>
	);
}

function Crossings({ data }: { data: NodeData }) {
	if (!data.crossings.length) return null;
	return (
		<div className="rn-crossings">
			{data.crossings.map((crossing) => (
				<button
					type="button"
					key={crossing.key}
					className="rn-crossing nodrag nopan"
					aria-label={`Why ${crossing.flights.join(" and ")} overlap at ${data.node.label}`}
					onClick={(event) => {
						event.stopPropagation();
						data.onCrossing(crossing.key);
					}}
				>
					<span aria-hidden="true">●</span> Crossing · {crossing.flights.join(" / ")}
				</button>
			))}
		</div>
	);
}

function Occupants({ list }: { list: NodeData["occupants"] }) {
	if (!list.length) return null;
	return (
		<span className="rn-occ">
			{list.map((o) => (
				<span
					key={o.flightId}
					className={`rn-occ-tag st-${o.state}`}
					title={`${o.flightId}: ${o.state === "partial" ? "partly waiting" : o.state === "held" ? "waiting" : o.state}`}
				>
					{o.flightId.replace("F-", "")}
				</span>
			))}
		</span>
	);
}

const ModuleNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className={`rn-module ${data.dim ? "dim" : ""} ${data.crossings.length ? "has-conflict" : ""}`}>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<div className="rn-module-label">
			<span>{data.node.label}</span>
			<Disclosure data={data} />
		</div>
		<div className="rn-module-summary">
			<span>{data.node.sub}</span>
			<Occupants list={data.occupants} />
		</div>
		<Crossings data={data} />
	</div>
));

const ComponentNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className={`rn-component ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""} ${data.crossings.length ? "conflict" : ""}`}>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<div className="rn-component-head">
			<span className="rn-component-label">{data.node.label}</span>
			<Occupants list={data.occupants} />
		</div>
		<div className="rn-component-disclosure">
			<Disclosure data={data} />
		</div>
		<Crossings data={data} />
	</div>
));

const SymbolNode = memo(({ data }: NodeProps<Node<NodeData>>) => (
	<div className={`rn-symbol ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""} ${data.crossings.length ? "conflict" : ""}`}>
		<Handle type="target" position={Position.Left} className="h-hidden" />
		<div className="rn-symbol-head">
			<span className="rn-symbol-label">{data.node.label}</span>
			<Occupants list={data.occupants} />
		</div>
		<Crossings data={data} />
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
	const labelWidth = (e.label?.length ?? 0) * 5.8 + 16;
	return (
		<g className={`re re-${e.mode} re-${e.state} ${data.dim ? "dim" : ""} ${data.focus ? "focus" : ""}`}>
			<BaseEdge id={id} path={path} />
			{e.label && (
				<g transform={`translate(${lx}, ${ly})`} className={`re-hold-tag ${e.state === "partial" ? "re-partial-tag" : ""}`}>
					<rect x={-labelWidth / 2} y={-10} width={labelWidth} height={20} rx={4} />
					<text textAnchor="middle" y={4}>
						{e.label}
					</text>
				</g>
			)}
		</g>
	);
}

const nodeTypes = { flight: FlightNode, module: ModuleNode, component: ComponentNode, symbol: SymbolNode };
const edgeTypes = { route: RouteEdgeView };

/** Project-keyed mount prevents disclosure and layout leaking between repositories. */
export function Radar(props: Props) {
	return <TrafficGraph key={props.state.project.id} {...props} />;
}

function TrafficGraph({ state, selection, hover, onSelect, onHover }: Props) {
	const [disclosure, setDisclosure] = useState<GraphDisclosure>({ expandedModules: new Set(), expandedFiles: new Set() });
	const structure = useMemo(() => buildStructure(state, disclosure), [state, disclosure]);
	const signature = signatureOf(structure);
	const [graph, setGraph] = useState<RadarGraph | null>(null);
	const [layoutError, setLayoutError] = useState(false);
	const flow = useRef<ReactFlowInstance<Node<NodeData>, Edge<EdgeData>> | null>(null);
	const lastFit = useRef("");
	const toggle = useCallback((item: NonNullable<RadarNode["disclosure"]>) => {
		setDisclosure((current) => {
			const key = item.kind === "module" ? "expandedModules" : "expandedFiles";
			const next = new Set(current[key]);
			if (next.has(item.key)) next.delete(item.key);
			else next.add(item.key);
			return { ...current, [key]: next };
		});
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: signature captures all geometry, not activity and clearance text.
	useEffect(() => {
		let cancelled = false;
		setLayoutError(false);
		layout(structure)
			.then((g) => {
				if (!cancelled) setGraph(g);
			})
			.catch(() => {
				if (!cancelled) setLayoutError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [signature]);

	const focusFlight = hover ?? (selection?.kind === "flight" ? selection.id : null);
	const focusCongestion = selection?.kind === "congestion" ? state.traffic.congestions.find((c) => c.key === selection.key) : undefined;
	const { nodes, edges } = useMemo(() => {
		if (!graph) return { nodes: [] as Node<NodeData>[], edges: [] as Edge<EdgeData>[] };
		const freshNodes = new Map(structure.nodes.map((n) => [n.id, n]));
		const placed = graph.nodes.filter((n) => freshNodes.has(n.id));
		const liveEdges = structure.edges;
		const focusFlights = new Set(focusCongestion ? focusCongestion.flights : focusFlight ? [focusFlight] : []);
		const related = new Set<string>();
		for (const e of liveEdges)
			if (focusFlights.has(e.flightId)) {
				related.add(e.source);
				related.add(e.target);
			}
		const parents = new Map(placed.map((n) => [n.id, n.parent]));
		for (const id of [...related]) {
			let parent = parents.get(id);
			while (parent) {
				related.add(parent);
				parent = parents.get(parent);
			}
		}
		const occupants = new Map<string, NodeData["occupants"]>();
		for (const e of liveEdges)
			if (e.kind === "route") occupants.set(e.target, [...(occupants.get(e.target) ?? []), { flightId: e.flightId, state: e.state }]);
		const anyFocus = focusFlights.size > 0;
		const nodes: Node<NodeData>[] = placed.map((positioned) => {
			const fresh = freshNodes.get(positioned.id)!;
			const n = { ...positioned, ...fresh, width: positioned.width, height: positioned.height };
			const f = n.flightId ? state.flights.find((x) => x.id === n.flightId) : undefined;
			const badge = f ? flightBadge(f, state.traffic.clearances[f.id], state) : undefined;
			return {
				id: n.id,
				type: n.kind,
				position: { x: n.x, y: n.y },
				parentId: n.parent,
				draggable: false,
				selectable: true,
				ariaLabel: f ? `${f.title}, ${badge?.label ?? ""}` : n.label,
				style: { width: n.width, height: n.height },
				zIndex: n.kind === "flight" ? 20 : undefined,
				data: {
					node: n,
					tone: badge?.tone,
					badge: badge?.label,
					activity: f?.activity?.text ?? f?.agentRuntime,
					dim: anyFocus && !related.has(n.id) && !(n.flightId && focusFlights.has(n.flightId)),
					focus: anyFocus && (related.has(n.id) || (!!n.flightId && focusFlights.has(n.flightId))),
					crossings: state.traffic.congestions
						.filter((c) => n.congestionKeys.includes(c.key))
						.map((c) => ({ key: c.key, flights: c.flights })),
					occupants: occupants.get(n.id) ?? [],
					onDisclosure: toggle,
					onCrossing: (key) => onSelect({ kind: "congestion", key }),
				},
			};
		});
		const shownIds = new Set(nodes.map((n) => n.id));
		const edges: Edge<EdgeData>[] = liveEdges
			.filter((e) => shownIds.has(e.source) && shownIds.has(e.target))
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
	}, [graph, structure, state, focusFlight, focusCongestion, toggle, onSelect]);

	useEffect(() => {
		if (!graph || !flow.current || lastFit.current === graph.signature) return;
		lastFit.current = graph.signature;
		const top = graph.nodes.filter((n) => !n.parent);
		if (!top.length) return;
		const xs = top.flatMap((n) => [n.x, n.x + n.width]);
		const ys = top.flatMap((n) => [n.y, n.y + n.height]);
		requestAnimationFrame(() =>
			flow.current?.fitBounds(
				{
					x: Math.min(...xs) - 100,
					y: Math.min(...ys) - 20,
					width: Math.max(...xs) - Math.min(...xs) + 120,
					height: Math.max(...ys) - Math.min(...ys) + 40,
				},
				{ padding: 0.06, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 },
			),
		);
	}, [graph]);

	return (
		<section className="radar" aria-label="Active task routes and code areas">
			<ReactFlow<Node<NodeData>, Edge<EdgeData>>
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onInit={(instance) => {
					flow.current = instance;
				}}
				onNodeClick={(_, n) => {
					if (n.data.node.flightId) onSelect({ kind: "flight", id: n.data.node.flightId });
					else if (n.data.node.resource) onSelect({ kind: "resource", id: n.data.node.resource });
				}}
				onNodeMouseEnter={(_, n) => n.data.node.flightId && onHover(n.data.node.flightId)}
				onNodeMouseLeave={() => onHover(null)}
				onPaneClick={() => onSelect(null)}
				nodesDraggable={false}
				nodesConnectable={false}
				proOptions={{ hideAttribution: true }}
				minZoom={0.25}
				maxZoom={2}
				fitView
			>
				<Background gap={28} size={1} color="var(--grid)" />
			</ReactFlow>
			{(structure.nodes.length === 0 || layoutError) && (
				<div className="radar-empty">
					<div className="radar-empty-title">{layoutError ? "Traffic map unavailable" : "No active routes"}</div>
					<div className="radar-empty-sub">
						{layoutError
							? "Task details and coordination decisions remain available in Work."
							: "Active plans appear here when agents begin work."}
					</div>
				</div>
			)}
		</section>
	);
}
