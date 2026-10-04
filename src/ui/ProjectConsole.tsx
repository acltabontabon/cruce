import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoordinationState, Decision, ProjectConnection } from "../shared/coordination.ts";
import type { PlatformCommand, PlatformState, PromotionReadiness, Proposal } from "../shared/platform.ts";

type View = Omit<PlatformState, "proposals"> & {
	project: ProjectConnection;
	coordination: Omit<CoordinationState, "workstreams"> & {
		workstreams: (CoordinationState["workstreams"][number] & { decision: Decision })[];
	};
	proposals: (Proposal & { readiness: PromotionReadiness })[];
	sourceBackend: string;
	permissions: { contribute: boolean; govern: boolean };
	sourceHealth?: { state: string; observedHead?: string; verifiedHead?: string };
};
async function request<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, {
		credentials: "same-origin",
		...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	if (!response.ok) {
		const result = (await response.json()) as { error?: string };
		throw new Error(result.error ?? `Request failed (${response.status})`);
	}
	return response.json() as Promise<T>;
}
export function ProjectConsole() {
	const [projects, setProjects] = useState<ProjectConnection[]>([]),
		[projectsLoaded, setProjectsLoaded] = useState(false),
		[selected, setSelected] = useState<string | null>(null),
		[view, setView] = useState<View | null>(null),
		[error, setError] = useState<string | null>(null),
		[detail, setDetail] = useState<string | null>(null),
		[lineage, setLineage] = useState(false),
		[title, setTitle] = useState(""),
		[context, setContext] = useState(""),
		[busy, setBusy] = useState(false);
	useEffect(() => {
		document.title = "Cruce · Development";
	}, []);
	const currentProject = useRef(selected);
	currentProject.current = selected;
	const load = useCallback(async () => {
		if (!selected) return;
		try {
			const snapshot = await request<View>(`/api/projects/snapshot?projectId=${encodeURIComponent(selected)}`);
			if (currentProject.current !== selected) return;
			setView(snapshot);
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}, [selected]);
	useEffect(() => {
		let current = true;
		void request<ProjectConnection[]>("/api/projects")
			.then((list) => {
				if (current) {
					setProjects(list);
					setSelected(list[0]?.id ?? null);
				}
			})
			.catch((e) => {
				if (current) setError(e.message);
			})
			.finally(() => {
				if (current) setProjectsLoaded(true);
			});
		return () => {
			current = false;
		};
	}, []);
	useEffect(() => {
		setView(null);
		setDetail(null);
		void load();
		const timer = setInterval(() => {
			void load();
		}, 15000);
		return () => clearInterval(timer);
	}, [load]);
	const execute = async (input: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => {
		if (!selected || view?.project.id !== selected) throw new Error("Refresh project context before acting");
		const result = await request("/api/projects/command", { ...input, projectId: selected, idempotencyKey: crypto.randomUUID() });
		await load();
		return result;
	};
	const proposal = view?.proposals.find((p) => p.id === detail),
		mission = view?.missions.find((m) => m.id === detail),
		artifact = view?.artifacts.find((a) => a.id === detail),
		intent = view?.intents.find((i) => i.id === detail),
		record =
			view?.verifications.find((v) => v.id === detail) ??
			view?.reviews.find((r) => r.id === detail) ??
			view?.promotions.find((p) => p.id === detail);
	return (
		<div className="app project-console">
			<a href="#main-content" className="skip-link">
				Skip to development activity
			</a>
			<header className="project-header">
				<a className="wordmark" href="/">
					Cruce
					<span className="brand-dot" />
				</a>
				<span className="muted">Development</span>
				<div className="spacer" />
				{projects.length > 0 && (
					<label className="project-selector">
						<span className="sr-only">Project</span>
						<select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
							{projects.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
					</label>
				)}
				<a className="muted" href="/demo">
					Demo
				</a>
			</header>
			<main id="main-content" className="project-main">
				{error && selected && (
					<div className="console-error" role="alert">
						{error} <a href="/auth/login">Sign in</a>
					</div>
				)}
				{!selected && error && (
					<section className="console-empty">
						<p className="eyebrow">Development activity</p>
						<h1>Sign in to Cruce.</h1>
						<p>Review active missions, proposed changes and their evidence.</p>
						<a className="btn" href="/auth/login">
							Sign in
						</a>
						<details>
							<summary>Connection details</summary>
							<p role="alert">{error}</p>
						</details>
					</section>
				)}
				{!projectsLoaded && !error && (
					<p className="muted" role="status">
						Loading development activity…
					</p>
				)}
				{projectsLoaded && !selected && !error && (
					<section className="console-empty">
						<h1>Give your agents a project to build.</h1>
						<p>Intent, source, evidence and decisions stay together. Your agents use their existing tools.</p>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								setBusy(true);
								void request<ProjectConnection>("/api/projects", { name: title, idempotencyKey: crypto.randomUUID() })
									.then((s) => {
										setProjects([s]);
										setSelected(s.id);
										setTitle("");
									})
									.catch((e) => setError(e.message))
									.finally(() => setBusy(false));
							}}
						>
							<label>
								Project name
								<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Payment service" />
							</label>
							<button type="submit" className="btn" disabled={busy}>
								{busy ? "Creating…" : "Create project"}
							</button>
						</form>
					</section>
				)}
				{selected && !view && !error && (
					<p role="status" className="muted">
						Loading source and activity…
					</p>
				)}
				{view && (
					<>
						<div className="overview-heading">
							<div>
								<p className="eyebrow">{view.project.name}</p>
								<h1>What’s happening</h1>
								<p className="muted">Agents perform the work. Evidence and review govern what becomes accepted.</p>
							</div>
							<button type="button" className="btn quiet" onClick={() => setLineage(!lineage)} aria-pressed={lineage}>
								{lineage ? "Overview" : "Lineage"}
							</button>
						</div>
						{view.sourceHealth && view.sourceHealth.state !== "verified" && (
							<p role="alert" className="coverage-note">
								Accepted source requires attention: {view.sourceHealth.state.replaceAll("_", " ")}. An external source change has not been
								accepted as a promotion.
							</p>
						)}
						{view.sourceBackend !== "cloudflare_artifacts" && (
							<p className="coverage-note">Offline source fixture. Managed publication and promotion require Cloudflare Artifacts.</p>
						)}
						{lineage ? (
							<Lineage view={view} onSelect={setDetail} />
						) : (
							<>
								<section className="activity-section" aria-labelledby="active-work">
									<h2 id="active-work">
										Active work <span className="count">{view.missions.filter((m) => m.state !== "completed").length}</span>
									</h2>
									{!view.missions.length ? (
										<p className="muted">No active missions. Define an intent below; connected agents can plan bounded work.</p>
									) : (
										view.missions
											.filter((m) => m.state !== "completed")
											.map((m) => {
												const w = view.coordination.workstreams.find((w) => w.id === m.workstreamId),
													sessions = view.coordination.sessions.filter((s) => s.workstreamId === m.workstreamId);
												return (
													<button type="button" key={m.id} className="workstream-row" onClick={() => setDetail(m.id)}>
														<span className="state-dot" data-state={w?.decision.displayStatus ?? "Ready"} />
														<span className="workstream-summary">
															<strong>{m.title}</strong>
															<small>
																{m.specialization} ·{" "}
																{sessions
																	.map((s) => s.tool)
																	.filter((s, i, a) => a.indexOf(s) === i)
																	.join(", ") || "Awaiting an agent"}
															</small>
															{w?.decision.constrained[0] && <small>{w.decision.constrained[0].reason}</small>}
														</span>
														<span className="task-status">{w?.decision.displayStatus ?? "Ready"}</span>
													</button>
												);
											})
									)}
								</section>
								<section className="activity-section" aria-labelledby="attention">
									<h2 id="attention">Needs your attention</h2>
									{view.proposals
										.filter((p) => p.state !== "promoted" && p.readiness.outcome !== "READY")
										.map((p) => (
											<button type="button" className="workstream-row" key={p.id} onClick={() => setDetail(p.id)}>
												<span className="state-dot" data-state="Needs attention" />
												<span className="workstream-summary">
													<strong>{p.summary}</strong>
													<small>{p.readiness.reasons[0]}</small>
												</span>
												<span className="task-status">{p.readiness.outcome === "REFRESH" ? "Plan needs refresh" : "Review evidence"}</span>
											</button>
										))}
									{!view.proposals.some((p) => p.state !== "promoted" && p.readiness.outcome !== "READY") && (
										<p className="muted">No proposal decisions waiting.</p>
									)}
								</section>
								<section className="activity-section" aria-labelledby="ready">
									<h2 id="ready">Ready</h2>
									{view.proposals
										.filter((p) => p.state !== "promoted" && p.readiness.outcome === "READY")
										.map((p) => (
											<button type="button" className="workstream-row" key={p.id} onClick={() => setDetail(p.id)}>
												<span className="state-dot" data-state="Ready" />
												<span className="workstream-summary">
													<strong>{p.summary}</strong>
													<small>Evidence and human review support promotion.</small>
												</span>
												<span className="task-status">Ready to promote</span>
											</button>
										))}
									{!view.proposals.some((p) => p.state !== "promoted" && p.readiness.outcome === "READY") && (
										<p className="muted">Verified proposals appear here when their policy requirements are met.</p>
									)}
								</section>
								<section className="activity-section">
									<h2>Recently changed</h2>
									{view.timeline
										.filter((e) => ["promotion", "decision", "review"].includes(e.kind))
										.slice(-6)
										.reverse()
										.map((e) => (
											<div className="timeline-row" key={e.id}>
												<span>{e.summary}</span>
												<small className="muted">
													{e.kind.replaceAll("_", " ")} · {e.actor}
												</small>
											</div>
										))}
									{!view.timeline.some((e) => ["promotion", "decision", "review"].includes(e.kind)) && (
										<p className="muted">Accepted changes and consequential decisions will appear here.</p>
									)}
								</section>
								<details className="intent-entry">
									<summary>Accepted source</summary>
									<SourceBrowser revision={view.project.canonicalHead!} execute={execute} />
								</details>
								<details className="intent-entry">
									<summary>Define intent</summary>
									<form
										onSubmit={(e) => {
											e.preventDefault();
											setBusy(true);
											void execute({ tool: "create_intent", title, context })
												.then(() => {
													setTitle("");
													setContext("");
												})
												.catch((e) => setError(e.message))
												.finally(() => setBusy(false));
										}}
									>
										<label>
											What should change?
											<input
												required
												maxLength={200}
												value={title}
												onChange={(e) => setTitle(e.target.value)}
												placeholder="Implement idempotent refunds"
											/>
										</label>
										<label>
											Context and desired outcome
											<textarea required maxLength={4000} value={context} onChange={(e) => setContext(e.target.value)} />
										</label>
										<button type="submit" disabled={busy} className="btn">
											{busy ? "Saving…" : "Record intent"}
										</button>
										<p className="muted">Connected agents discover intents through MCP, create bounded missions and produce proposals.</p>
									</form>
								</details>
							</>
						)}
						{mission && (
							<section className="workstream-detail">
								<button type="button" className="btn quiet" onClick={() => setDetail(null)}>
									Close
								</button>
								<p className="eyebrow">Mission · {mission.specialization}</p>
								<h2>{mission.title}</h2>
								<p>{mission.plan.intent}</p>
								<details>
									<summary>Plan, scope and coordination</summary>
									<pre>
										{JSON.stringify(
											{ plan: mission.plan, decision: view.coordination.workstreams.find((w) => w.id === mission.workstreamId)?.decision },
											null,
											2,
										)}
									</pre>
								</details>
								<h3>Outputs</h3>
								{view.artifacts
									.filter((a) => a.missionId === mission.id)
									.map((a) => (
										<details key={a.id}>
											<summary>
												{a.title}{" "}
												<span className="muted">
													{a.kind.replaceAll("_", " ")} · {a.trust}
												</span>
											</summary>
											<p>{a.summary}</p>
											<pre>{JSON.stringify(a, null, 2)}</pre>
										</details>
									))}
							</section>
						)}
						{intent && (
							<section className="workstream-detail">
								<button type="button" className="btn quiet" onClick={() => setDetail(null)}>
									Close
								</button>
								<p className="eyebrow">Intent</p>
								<h2>{intent.title}</h2>
								<p>{intent.context}</p>
								<p>{intent.why}</p>
								{view.missions
									.filter((m) => m.intentId === intent.id)
									.map((m) => (
										<button type="button" className="timeline-row" key={m.id} onClick={() => setDetail(m.id)}>
											{m.title}
										</button>
									))}
							</section>
						)}
						{artifact && <ArtifactDetail key={artifact.id} artifact={artifact} execute={execute} onClose={() => setDetail(null)} />}
						{record && (
							<section className="workstream-detail">
								<button type="button" className="btn quiet" onClick={() => setDetail(null)}>
									Close
								</button>
								<h2>Decision and evidence</h2>
								<pre>{JSON.stringify(record, null, 2)}</pre>
							</section>
						)}
						{proposal && (
							<ProposalDetail key={proposal.id} proposal={proposal} view={view} execute={execute} onClose={() => setDetail(null)} />
						)}
					</>
				)}
			</main>
		</div>
	);
}
function ProposalDetail({
	proposal,
	view,
	execute,
	onClose,
}: {
	proposal: View["proposals"][number];
	view: View;
	execute: (cmd: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => Promise<unknown>;
	onClose: () => void;
}) {
	const [summary, setSummary] = useState(""),
		[error, setError] = useState<string | null>(null),
		[diff, setDiff] = useState<unknown>(null),
		[evidenceId, setEvidenceId] = useState(""),
		[verificationKind, setVerificationKind] = useState<NonNullable<PlatformCommand["verificationKind"]>>("tests"),
		[attestation, setAttestation] = useState(""),
		[busy, setBusy] = useState(false);
	const action = (cmd: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => {
		setBusy(true);
		void execute({ ...cmd, proposalId: proposal.id, expectedVersion: proposal.version })
			.catch((e) => setError(e.message))
			.finally(() => setBusy(false));
	};
	return (
		<section className="workstream-detail">
			<button type="button" className="btn quiet" onClick={onClose}>
				Close
			</button>
			<p className="eyebrow">Proposal · {proposal.risk} risk</p>
			<h2>{proposal.summary}</h2>
			<p>{proposal.impact || "No architectural impact statement supplied."}</p>
			{proposal.risks.length > 0 && (
				<ul>
					{proposal.risks.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}
			<h3>Evidence</h3>
			{view.verifications
				.filter((v) => v.proposalId === proposal.id)
				.map((v) => (
					<div key={v.id} className="evidence-row">
						<strong>
							{v.kind.replaceAll("_", " ")} · {v.outcome}
						</strong>
						<span>{v.summary}</span>
						<small className="muted">
							{v.trust.replaceAll("_", " ")} · exact revision {v.revision.slice(0, 12)}
						</small>
					</div>
				))}
			{!view.verifications.some((v) => v.proposalId === proposal.id) && (
				<p className="muted">No verification evidence attached. Reported agent results alone do not satisfy promotion policy.</p>
			)}
			<details>
				<summary>Diff and source revision</summary>
				<button
					type="button"
					className="btn quiet"
					onClick={() => {
						void execute({ tool: "get_diff", proposalId: proposal.id })
							.then(setDiff)
							.catch((e) => setError(e.message));
					}}
				>
					Read diff
				</button>
				<pre>{diff ? JSON.stringify(diff, null, 2) : `Source revision ${proposal.revision}\nParent revision ${proposal.base}`}</pre>
			</details>
			<details>
				<summary>Attest verification evidence</summary>
				<p className="muted">Record evidence you have inspected. This is a human attestation, not a Cruce-executed test.</p>
				<label>
					Evidence artifact
					<select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)}>
						<option value="">Select an exact-revision report</option>
						{view.artifacts
							.filter((a) => a.revision === proposal.revision && a.kind !== "source")
							.map((a) => (
								<option key={a.id} value={a.id}>
									{a.title} · {a.kind.replaceAll("_", " ")}
								</option>
							))}
					</select>
				</label>
				<label>
					Verification kind
					<select
						value={verificationKind}
						onChange={(e) => setVerificationKind(e.target.value as NonNullable<PlatformCommand["verificationKind"]>)}
					>
						{["tests", "static_analysis", "security", "architecture", "benchmark"].map((kind) => (
							<option key={kind} value={kind}>
								{kind.replaceAll("_", " ")}
							</option>
						))}
					</select>
				</label>
				<label>
					What did you verify?
					<textarea maxLength={2000} value={attestation} onChange={(e) => setAttestation(e.target.value)} />
				</label>
				<div className="review-actions">
					<button
						type="button"
						className="btn"
						disabled={busy || !view.permissions.contribute || !evidenceId || !attestation.trim() || proposal.state !== "proposed"}
						onClick={() =>
							action({ tool: "attach_verification", verificationKind, related: [evidenceId], summary: attestation, outcome: "pass" })
						}
					>
						Attest pass
					</button>
					<button
						type="button"
						className="btn quiet"
						disabled={busy || !view.permissions.contribute || !evidenceId || !attestation.trim() || proposal.state !== "proposed"}
						onClick={() =>
							action({ tool: "attach_verification", verificationKind, related: [evidenceId], summary: attestation, outcome: "fail" })
						}
					>
						Record failure
					</button>
				</div>
			</details>
			<h3>Reviews</h3>
			{view.reviews
				.filter((r) => r.proposalId === proposal.id)
				.map((r) => (
					<div key={r.id} className="evidence-row">
						<strong>
							{r.outcome} · {r.actorKind}
						</strong>
						<p>{r.summary}</p>
						{r.resolved ? (
							<small className="muted">Decision: {r.resolved.reason}</small>
						) : (
							r.outcome !== "approve" && (
								<button
									type="button"
									className="btn quiet"
									disabled={busy || proposal.state !== "proposed" || !view.permissions.contribute || !summary.trim()}
									onClick={() => action({ tool: "resolve_review", reviewId: r.id, reason: summary })}
								>
									Resolve with the reason below
								</button>
							)
						)}
					</div>
				))}
			{proposal.state !== "promoted" && (
				<>
					<label>
						Review or decision reason
						<textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={1000} />
					</label>
					<div className="review-actions">
						<button
							type="button"
							className="btn"
							disabled={busy || proposal.state !== "proposed" || !view.permissions.contribute || !summary.trim()}
							onClick={() => action({ tool: "review_proposal", outcome: "approve", summary })}
						>
							Approve this revision
						</button>
						<button
							type="button"
							className="btn quiet"
							disabled={busy || proposal.state !== "proposed" || !view.permissions.contribute || !summary.trim()}
							onClick={() => action({ tool: "review_proposal", outcome: "concern", summary })}
						>
							Raise a concern
						</button>
					</div>
					{proposal.readiness.reasons.map((r) => (
						<p className="coverage-note" key={r}>
							{r}
						</p>
					))}
					<button
						type="button"
						className="btn"
						disabled={busy || !view.permissions.govern || proposal.readiness.outcome !== "READY"}
						onClick={() => action({ tool: "promote_proposal" })}
					>
						{busy ? "Applying…" : "Promote accepted source"}
					</button>
					<p className="muted">Promotion advances accepted source. Deployment follows its own environment policy.</p>
				</>
			)}
			<details>
				<summary>Provenance and decision history</summary>
				<pre>
					{JSON.stringify(
						{
							proposal,
							source: view.artifacts.find((a) => a.id === proposal.artifactId),
							policy: view.policy,
							history: view.timeline.filter((e) => e.ids.includes(proposal.id)),
						},
						null,
						2,
					)}
				</pre>
			</details>
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
function Lineage({ view, onSelect }: { view: View; onSelect: (id: string) => void }) {
	const [nodes, setNodes] = useState<Node[]>([]),
		[edges, setEdges] = useState<Edge[]>([]);
	useEffect(() => {
		let current = true;
		const records = [
			...view.intents.map((i) => ({ id: i.id, title: i.title, kind: "Intent" })),
			...view.missions.map((m) => ({ id: m.id, title: m.title, kind: "Mission" })),
			...view.artifacts.map((a) => ({ id: a.id, title: a.title, kind: a.kind.replaceAll("_", " ") })),
			...view.proposals.map((p) => ({ id: p.id, title: p.summary, kind: "Proposal" })),
			...view.verifications.map((v) => ({ id: v.id, title: `${v.kind}: ${v.outcome}`, kind: v.trust.replaceAll("_", " ") })),
			...view.reviews.map((r) => ({ id: r.id, title: r.summary, kind: `${r.actorKind} ${r.outcome}` })),
			...view.promotions.map((p) => ({
				id: p.id,
				title: p.state === "complete" ? "Accepted source" : "Promotion prepared",
				kind: "Promotion",
			})),
		];
		const edges: Edge[] = [
			...view.missions.map((m) => ({ id: `${m.intentId}:${m.id}`, source: m.intentId, target: m.id })),
			...view.artifacts.flatMap((a) => [
				{ id: `${a.missionId}:${a.id}`, source: a.missionId, target: a.id },
				...a.related.map((id) => ({ id: `${id}:${a.id}`, source: id, target: a.id })),
			]),
			...view.proposals.map((p) => ({ id: `${p.artifactId}:${p.id}`, source: p.artifactId, target: p.id })),
			...view.verifications.flatMap((v) => [
				{ id: `${v.proposalId}:${v.id}`, source: v.proposalId, target: v.id },
				...v.artifactIds.map((id) => ({ id: `${id}:${v.id}`, source: id, target: v.id })),
			]),
			...view.reviews.map((r) => ({ id: `${r.proposalId}:${r.id}`, source: r.proposalId, target: r.id })),
			...view.promotions.flatMap((p) => [
				{ id: `${p.proposalId}:${p.id}`, source: p.proposalId, target: p.id },
				...[...(p.evidenceIds ?? []), ...(p.reviewIds ?? [])].map((id) => ({ id: `${id}:${p.id}`, source: id, target: p.id })),
			]),
		];
		void import("elkjs/lib/elk.bundled.js")
			.then(({ default: ELK }) =>
				new ELK().layout({
					id: "root",
					layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "40" },
					children: records.map((r) => ({ id: r.id, width: 230, height: 90 })),
					edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
				}),
			)
			.then((graph) => {
				if (current) {
					setNodes(
						(graph.children ?? []).map((n) => {
							const r = records.find((r) => r.id === n.id)!;
							return {
								id: n.id,
								position: { x: n.x ?? 0, y: n.y ?? 0 },
								data: {
									label: (
										<button className="graph-workstream" type="button" onClick={() => onSelect(r.id)}>
											<small>{r.kind}</small>
											<br />
											<strong>{r.title}</strong>
										</button>
									),
								},
								style: { width: 230 },
							};
						}),
					);
					setEdges(edges);
				}
			})
			.catch(() => {
				if (current) {
					setNodes([]);
					setEdges([]);
				}
			});
		return () => {
			current = false;
		};
	}, [view, onSelect]);
	return (
		<section className="coordination-graph" aria-label="Intent to promotion lineage">
			<ReactFlow nodes={nodes} edges={edges} fitView nodesFocusable edgesFocusable nodesDraggable={false}>
				<Background />
				<Controls />
			</ReactFlow>
			<p className="muted">
				Intent → mission → artifacts → proposal → verification → promotion. Use Tab and Enter to inspect the source, evidence and decisions.
			</p>
			<details>
				<summary>Read the same lineage as a timeline</summary>
				{view.timeline.map((e) => (
					<p key={e.id}>
						<strong>{e.kind.replaceAll("_", " ")}</strong> · {e.summary}
					</p>
				))}
			</details>
		</section>
	);
}

function ArtifactDetail({
	artifact,
	execute,
	onClose,
}: {
	artifact: PlatformState["artifacts"][number];
	execute: (cmd: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => Promise<unknown>;
	onClose: () => void;
}) {
	const [body, setBody] = useState<unknown>(null),
		[error, setError] = useState("");
	return (
		<section className="workstream-detail">
			<button type="button" className="btn quiet" onClick={onClose}>
				Close
			</button>
			<p className="eyebrow">
				{artifact.kind.replaceAll("_", " ")} · {artifact.trust}
			</p>
			<h2>{artifact.title}</h2>
			<p>{artifact.summary}</p>
			<p className="muted">
				Produced by {artifact.producer.tool ?? artifact.producer.actor} · {artifact.environment}
			</p>
			<button
				type="button"
				className="btn quiet"
				onClick={() => {
					void execute({ tool: "read_artifact", artifactId: artifact.id })
						.then(setBody)
						.catch((e) => setError(e.message));
				}}
			>
				Inspect output
			</button>
			{artifact.kind === "source" && <SourceBrowser revision={artifact.revision} execute={execute} />}
			{body !== null && <pre>{JSON.stringify(body, null, 2)}</pre>}
			<details>
				<summary>Provenance</summary>
				<pre>{JSON.stringify(artifact, null, 2)}</pre>
			</details>
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

function SourceBrowser({
	revision,
	execute,
}: {
	revision: string;
	execute: (cmd: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => Promise<unknown>;
}) {
	const [paths, setPaths] = useState<string[]>([]),
		[path, setPath] = useState(""),
		[content, setContent] = useState(""),
		[error, setError] = useState("");
	return (
		<div className="source-browser">
			<p className="muted">Immutable source revision {revision.slice(0, 12)} · read only</p>
			<button
				type="button"
				className="btn quiet"
				onClick={() => {
					void execute({ tool: "get_source", revision })
						.then((r) => setPaths((r as { paths: string[] }).paths))
						.catch((e) => setError(e.message));
				}}
			>
				List source files
			</button>
			{paths.length > 0 && (
				<label>
					Source file
					<select
						value={path}
						onChange={(e) => {
							const selected = e.target.value;
							setPath(selected);
							void execute({ tool: "get_source", revision, path: selected })
								.then((r) => {
									const source = r as { content?: string; truncated?: boolean };
									setContent(source.content ?? "Source file unavailable");
									setError(
										source.truncated ? "This source excerpt is bounded to 100,000 characters. Export source for the complete file." : "",
									);
								})
								.catch((e) => setError(e.message));
						}}
					>
						<option value="">Choose a file</option>
						{paths.map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				</label>
			)}
			{path && <pre>{content}</pre>}
			{error && <p role="status">{error}</p>}
		</div>
	);
}
