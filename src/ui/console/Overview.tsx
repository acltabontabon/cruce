import { useState } from "react";
import { RESOURCE_LABELS } from "../../core/capabilities.ts";
import { type Execute, href, label, liveIn, READINESS_LABEL, short, type View } from "./model.ts";

/** Project state in seconds: what runs where, what needs a human, and what agents are doing. */
export function Overview({ view, execute }: { view: View; execute: Execute }) {
	const production = liveIn(view, "production"),
		preview = view.environments.find((e) => e.kind === "preview");
	const latestPreview = view.deployments.filter((d) => d.environmentId === preview?.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
	const attention = view.proposals.filter((p) => p.state === "proposed" && p.readiness.outcome !== "READY");
	const ready = view.proposals.filter((p) => p.state === "proposed" && p.readiness.outcome === "READY");
	const requests = view.resourceRequests.filter((r) => r.state === "pending");
	const active = view.missions.filter((m) => m.state === "active");
	const recent = view.timeline
		.filter((e) => ["promotion", "deployment", "decision", "proposal"].includes(e.kind))
		.slice(-6)
		.reverse();
	return (
		<>
			<div className="overview-heading">
				<div>
					<p className="eyebrow">Project</p>
					<h1>{view.project.name}</h1>
				</div>
			</div>
			<dl className="state-grid" aria-label="Project state">
				<div>
					<dt>Production</dt>
					<dd>
						{production ? (
							<>
								<code className="rev">{short(production.revision)}</code>
								<span className="muted"> {production.url ? new URL(production.url).host : "deployed"}</span>
							</>
						) : (
							<span className="muted">
								{view.environments.some((e) => e.kind === "production") ? "Nothing deployed yet" : "Not configured"}
							</span>
						)}
					</dd>
				</div>
				<div>
					<dt>Accepted source</dt>
					<dd>
						<code className="rev">{short(view.canonical.revision)}</code>
						{view.canonical.proposal && (
							<a className="muted" href={href({ view: "proposal", id: view.canonical.proposal.id })}>
								{" "}
								#{view.canonical.proposal.number} {view.canonical.proposal.summary}
							</a>
						)}
					</dd>
				</div>
				<div>
					<dt>Preview</dt>
					<dd>
						{latestPreview ? (
							<>
								<span
									className="state-dot"
									data-state={
										latestPreview.state === "deployed" ? "Ready" : latestPreview.state === "failed" ? "Needs attention" : "Waiting"
									}
								/>
								{label(latestPreview.state)} <code className="rev">{short(latestPreview.revision)}</code>
							</>
						) : (
							<span className="muted">{preview ? "No previews yet" : "Not configured"}</span>
						)}
					</dd>
				</div>
				<div>
					<dt>Source</dt>
					<dd>
						{view.source.backend === "cloudflare_artifacts" ? "Cloudflare Artifacts" : "Offline fixture"}
						<span className="muted"> {view.source.name}</span>
					</dd>
				</div>
			</dl>
			{view.sourceHealth && view.sourceHealth.state !== "verified" && (
				<p role="alert" className="coverage-note">
					Accepted source requires attention: {label(view.sourceHealth.state)}. A change made outside Cruce has not been accepted as a
					promotion.
				</p>
			)}
			{view.sourceBackend !== "cloudflare_artifacts" && (
				<p className="coverage-note">Offline fixture. Source is not stored in Cloudflare Artifacts and cannot be promoted.</p>
			)}
			<section className="activity-section" aria-labelledby="attention">
				<h2 id="attention">
					Needs you <span className="count">{attention.length + ready.length + requests.length}</span>
				</h2>
				{attention.length + ready.length + requests.length === 0 && <p className="muted">Nothing is waiting on a human decision.</p>}
				{ready.map((p) => (
					<a key={p.id} className="workstream-row" href={href({ view: "proposal", id: p.id })}>
						<span className="state-dot" data-state="Ready" />
						<span className="workstream-summary">
							<strong>
								#{p.number} {p.summary}
							</strong>
							<small>
								Ready to promote · <code>{short(p.revision)}</code> · {p.files} files
							</small>
						</span>
					</a>
				))}
				{attention.map((p) => (
					<a key={p.id} className="workstream-row" href={href({ view: "proposal", id: p.id })}>
						<span className="state-dot" data-state="Needs attention" />
						<span className="workstream-summary">
							<strong>
								#{p.number} {p.summary}
							</strong>
							<small>
								{READINESS_LABEL[p.readiness.outcome]} · {p.readiness.reasons[0]}
							</small>
						</span>
					</a>
				))}
				{requests.map((r) => (
					<ResourceDecision key={r.id} view={view} request={r} execute={execute} />
				))}
			</section>
			<section className="activity-section" aria-labelledby="active">
				<h2 id="active">
					Active missions <span className="count">{active.length}</span>
				</h2>
				{active.length === 0 && <p className="muted">No agent is working. Missions start from a concrete accepted revision.</p>}
				{active.map((m) => (
					<a key={m.id} className="workstream-row" href={href({ view: "mission", id: m.id })}>
						<span className="state-dot" data-state={m.decision?.displayStatus ?? "Waiting"} />
						<span className="workstream-summary">
							<strong>{m.title}</strong>
							<small>
								{m.agent?.tool ?? "agent"} · <code>{short(m.baseRevision)}</code> → <code>{short(m.headRevision)}</code>
								{m.decision ? ` · ${m.decision.displayStatus}` : ""}
								{m.experimentOf ? " · experiment" : ""}
							</small>
						</span>
					</a>
				))}
			</section>
			<section className="activity-section" aria-labelledby="recent">
				<h2 id="recent">Recent changes</h2>
				{recent.length === 0 && <p className="muted">No proposals or deployments yet.</p>}
				{recent.map((e) => (
					<p key={e.id} className="timeline-row">
						<span className="muted">{label(e.kind)}</span> {e.summary}
					</p>
				))}
			</section>
			<DeploymentSummary view={view} />
		</>
	);
}

function ResourceDecision({ view, request, execute }: { view: View; request: View["resourceRequests"][number]; execute: Execute }) {
	const [reason, setReason] = useState(""),
		[error, setError] = useState("");
	const decide = (decision: "approve" | "deny") =>
		void execute({ tool: "decide_resource_request", requestId: request.id, decision, reason }).catch((e) => setError(e.message));
	return (
		<div className="workstream-row resource-request">
			<span className="state-dot" data-state="Needs attention" />
			<span className="workstream-summary">
				<strong>{RESOURCE_LABELS[request.action]}</strong>
				<small>
					{request.reason} · {label(request.cost)}
					{request.proposalId && ` · ${view.proposals.find((p) => p.id === request.proposalId)?.summary ?? request.proposalId}`}
				</small>
				{view.permissions.govern && (
					<span className="review-actions">
						<input aria-label="Decision reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
						<button type="button" className="btn" disabled={!reason.trim()} onClick={() => decide("approve")}>
							Approve
						</button>
						<button type="button" className="btn quiet" disabled={!reason.trim()} onClick={() => decide("deny")}>
							Deny
						</button>
					</span>
				)}
				{error && <small role="alert">{error}</small>}
			</span>
		</div>
	);
}

function DeploymentSummary({ view }: { view: View }) {
	const profile = view.deploymentProfile;
	const worker = profile?.kind === "cloudflare_worker";
	const environments = view.environments;
	return (
		<section className="activity-section" aria-labelledby="deployment">
			<h2 id="deployment">Deployment</h2>
			{worker ? (
				<p>
					Cloudflare Worker detected{" "}
					<span className="muted">
						({profile.configPath}
						{profile.workerName ? ` · ${profile.workerName}` : ""})
					</span>
				</p>
			) : (
				<p className="muted">
					No Worker configuration in accepted source. Missions, proposals, verification and lineage work for any application.
				</p>
			)}
			<ul className="plain-list">
				<li>
					Source{" "}
					<span className="muted">· {view.source.backend === "cloudflare_artifacts" ? "Cloudflare Artifacts" : "offline fixture"}</span>
				</li>
				<li>
					Local development{" "}
					<span className="muted">· agents build and test on the developer machine; {view.resourceImpact.local.label.toLowerCase()}</span>
				</li>
				{(["preview", "production"] as const).map((kind) => {
					const env = environments.find((e) => e.kind === kind);
					return (
						<li key={kind}>
							{kind === "preview" ? "Preview" : "Production"}{" "}
							<span className="muted">
								·{" "}
								{env
									? `${env.target.type === "cloudflare_worker" ? `Worker ${env.target.workerName}` : env.target.description} · ${view.resourceImpact[kind].label}`
									: "not configured"}
							</span>
						</li>
					);
				})}
			</ul>
			{view.permissions.govern && (
				<a className="btn quiet" href={href({ view: "environments" })}>
					{environments.length ? "Environments and resources" : worker ? "Enable deployment" : "Configure environments"}
				</a>
			)}
		</section>
	);
}
