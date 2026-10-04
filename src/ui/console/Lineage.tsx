import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { PlatformState } from "../../shared/platform.ts";
import { type Execute, href, label, liveIn, short, TRUST_LABEL, type View } from "./model.ts";

type Trace = Pick<
	PlatformState,
	"missions" | "artifacts" | "proposals" | "verifications" | "reviews" | "promotions" | "deployments" | "environments"
> & {
	revisions: string[];
};
interface Record {
	id: string;
	kind: string;
	title: string;
	link?: string;
}

/** Mission → agent → revision → artifacts → proposal → verification → preview → promotion → production, and back. */
export function Lineage({ view, subject, execute }: { view: View; subject?: string; execute: Execute }) {
	const live = liveIn(view, "production");
	const target = subject ?? live?.id;
	const [trace, setTrace] = useState<Trace | null>(null),
		[error, setError] = useState("");
	useEffect(() => {
		let current = true;
		if (!target) {
			setTrace(null);
			return;
		}
		void execute({ tool: "get_lineage", subjectId: target })
			.then((t) => current && setTrace(t as Trace))
			.catch((e) => current && setError(e.message));
		return () => {
			current = false;
		};
	}, [target, execute]);
	const scope = useMemo<Trace>(() => trace ?? { ...view, revisions: [...new Set(view.artifacts.map((a) => a.revision))] }, [trace, view]);
	return (
		<section aria-labelledby="lineage-title">
			<div className="overview-heading">
				<div>
					<p className="eyebrow">{view.project.name}</p>
					<h1 id="lineage-title">Lineage</h1>
					<p className="muted">
						{target ? (
							<>
								Traced from <code>{target}</code>
								{subject ? (
									<>
										{" · "}
										<a href={href({ view: "lineage" })}>{live ? "trace production" : "show everything"}</a>
									</>
								) : (
									" (running in production)"
								)}
							</>
						) : (
							"Everything Cruce has recorded for this project."
						)}
					</p>
				</div>
			</div>
			{trace && <Chain trace={trace} view={view} />}
			<Graph scope={scope} view={view} />
			{error && <p role="alert">{error}</p>}
			<details>
				<summary>Read the same lineage as a timeline</summary>
				{view.timeline
					.filter(
						(e) => !trace || e.ids.some((id) => [...trace.missions, ...trace.proposals, ...trace.deployments].some((r) => r.id === id)),
					)
					.map((e) => (
						<p key={e.id} className="timeline-row">
							<span className="muted">{label(e.kind)}</span> {e.summary}
						</p>
					))}
			</details>
		</section>
	);
}

function Chain({ trace, view }: { trace: Trace; view: View }) {
	const steps: { label: string; values: { text: string; link?: string }[] }[] = [
		{ label: "Mission", values: trace.missions.map((m) => ({ text: m.title, link: href({ view: "mission", id: m.id }) })) },
		{ label: "Agent", values: [...new Set(trace.missions.flatMap((m) => (m.agent ? [m.agent.tool] : [])))].map((text) => ({ text })) },
		{ label: "Git revision", values: trace.revisions.map((r) => ({ text: short(r) })) },
		{
			label: "Artifacts",
			values: trace.artifacts
				.filter((a) => a.kind !== "source")
				.map((a) => ({ text: `${label(a.kind)}`, link: href({ view: "artifact", id: a.id }) })),
		},
		{
			label: "Proposal",
			values: trace.proposals.map((p) => ({ text: `#${p.number} ${p.summary}`, link: href({ view: "proposal", id: p.id }) })),
		},
		{
			label: "Verification",
			values: trace.verifications.map((v) => ({ text: `${label(v.kind)} ${v.outcome} · ${TRUST_LABEL[v.trust]}` })),
		},
		{
			label: "Approval",
			values: trace.reviews.filter((r) => r.actorKind === "human" && r.outcome === "approve").map((r) => ({ text: r.actor })),
		},
		{
			label: "Deployment",
			values: trace.deployments.map((d) => ({
				text: `${view.environments.find((e) => e.id === d.environmentId)?.name ?? "Environment"} · ${short(d.revision)} · ${label(d.state)}`,
			})),
		},
	].filter((s) => s.values.length);
	return (
		<ol className="lineage-chain">
			{steps.map((s) => (
				<li key={s.label}>
					<span className="muted">{s.label}</span>
					{s.values.map((v) =>
						v.link ? (
							<a key={v.text + v.link} href={v.link}>
								{v.text}
							</a>
						) : (
							<span key={v.text}>{v.text}</span>
						),
					)}
				</li>
			))}
		</ol>
	);
}

function Graph({ scope, view }: { scope: Trace; view: View }) {
	const [nodes, setNodes] = useState<Node[]>([]),
		[edges, setEdges] = useState<Edge[]>([]);
	useEffect(() => {
		let current = true;
		const rev = (r: string) => `rev:${r}`;
		const agents = scope.missions.filter((m) => m.agent).map((m) => ({ id: `agent:${m.id}`, mission: m.id, tool: m.agent!.tool }));
		const records: Record[] = [
			...scope.missions.map((m) => ({ id: m.id, title: m.title, kind: "Mission", link: href({ view: "mission", id: m.id }) })),
			...agents.map((a) => ({ id: a.id, title: a.tool, kind: "Agent" })),
			...scope.revisions.map((r) => ({ id: rev(r), title: short(r), kind: "Git revision" })),
			...scope.artifacts
				.filter((a) => a.kind !== "source")
				.map((a) => ({ id: a.id, title: a.title, kind: label(a.kind), link: href({ view: "artifact", id: a.id }) })),
			...scope.proposals.map((p) => ({
				id: p.id,
				title: `#${p.number} ${p.summary}`,
				kind: "Proposal",
				link: href({ view: "proposal", id: p.id }),
			})),
			...scope.verifications.map((v) => ({ id: v.id, title: `${label(v.kind)}: ${v.outcome}`, kind: TRUST_LABEL[v.trust] })),
			...scope.promotions.map((t) => ({
				id: t.id,
				title: t.state === "complete" ? `Accepted ${short(t.to)}` : "Promotion prepared",
				kind: "Promotion",
			})),
			...scope.deployments.map((d) => ({
				id: d.id,
				title: `${short(d.revision)} · ${label(d.state)}`,
				kind: view.environments.find((e) => e.id === d.environmentId)?.name ?? "Deployment",
			})),
		];
		const known = new Set(records.map((r) => r.id));
		const sourceOf = new Map(scope.artifacts.filter((a) => a.kind === "source").map((a) => [a.id, a.revision]));
		const raw: [string, string][] = [
			...scope.missions.flatMap((m) => (m.experimentOf ? [[m.experimentOf, m.id] as [string, string]] : [])),
			...agents.map((a) => [a.mission, a.id] as [string, string]),
			...scope.artifacts
				.filter((a) => a.kind === "source")
				.map((a) => [agents.find((x) => x.mission === a.missionId)?.id ?? a.missionId, rev(a.revision)] as [string, string]),
			...scope.artifacts.filter((a) => a.kind !== "source").map((a) => [rev(a.revision), a.id] as [string, string]),
			...scope.proposals.map((p) => [rev(sourceOf.get(p.artifactId) ?? p.revision), p.id] as [string, string]),
			...scope.verifications.map((v) => [v.proposalId, v.id] as [string, string]),
			...scope.promotions.map((t) => [t.proposalId, t.id] as [string, string]),
			...scope.deployments.map((d) => [d.promotionId ?? d.proposalId ?? rev(d.revision), d.id] as [string, string]),
		];
		const graphEdges: Edge[] = raw
			.filter(([a, b]) => known.has(a) && known.has(b))
			.map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
		void import("elkjs/lib/elk.bundled.js")
			.then(({ default: ELK }) =>
				new ELK().layout({
					id: "root",
					layoutOptions: {
						"elk.algorithm": "layered",
						"elk.direction": "RIGHT",
						"elk.spacing.nodeNode": "28",
						"elk.layered.spacing.nodeNodeBetweenLayers": "48",
					},
					children: records.map((r) => ({ id: r.id, width: 210, height: 64 })),
					edges: graphEdges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
				}),
			)
			.then((graph) => {
				if (!current) return;
				setNodes(
					(graph.children ?? []).map((n) => {
						const r = records.find((r) => r.id === n.id)!;
						const body = (
							<>
								<small>{r.kind}</small>
								<br />
								<strong>{r.title}</strong>
							</>
						);
						return {
							id: n.id,
							position: { x: n.x ?? 0, y: n.y ?? 0 },
							data: {
								label: r.link ? (
									<a className="graph-workstream" href={r.link}>
										{body}
									</a>
								) : (
									<span className="graph-workstream">{body}</span>
								),
							},
							style: { width: 210 },
						};
					}),
				);
				setEdges(graphEdges);
			})
			.catch(() => {
				if (current) setNodes([]);
			});
		return () => {
			current = false;
		};
	}, [scope, view]);
	return (
		<section className="coordination-graph" aria-label="Lineage graph">
			<ReactFlow nodes={nodes} edges={edges} fitView nodesFocusable edgesFocusable nodesDraggable={false}>
				<Background />
				<Controls />
			</ReactFlow>
		</section>
	);
}
