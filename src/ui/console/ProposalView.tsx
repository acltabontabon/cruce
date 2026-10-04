import { useCallback, useEffect, useState } from "react";
import type { ChangeFile } from "../../shared/api.ts";
import type { Artifact, Deployment, Verification, VerificationRequest } from "../../shared/platform.ts";
import { type Execute, href, label, READINESS_LABEL, short, TRUST_LABEL, type View } from "./model.ts";

interface Detail {
	commits: { oid: string; message: string }[];
	changes: { files: ChangeFile[]; additions: number; deletions: number; statsComplete: boolean };
	evidence: Artifact[];
	verificationRequests: VerificationRequest[];
}

/** Everything a human needs to decide: exact Git state, evidence on that exact revision, cost, and the decision. */
export function ProposalView({ view, id, execute }: { view: View; id: string; execute: Execute }) {
	const p = view.proposals.find((p) => p.id === id);
	const [detail, setDetail] = useState<Detail | null>(null),
		[error, setError] = useState(""),
		[reason, setReason] = useState(""),
		[file, setFile] = useState<{ path: string; patch: string | null; reason?: string } | null>(null);
	const version = p?.version;
	useEffect(() => {
		if (version === undefined) return;
		let current = true;
		void execute({ tool: "get_proposal", proposalId: id })
			.then((d) => current && setDetail(d as Detail))
			.catch((e) => current && setError(e.message));
		return () => {
			current = false;
		};
	}, [id, version, execute]);
	const act = useCallback(
		(cmd: Parameters<Execute>[0]) => {
			setError("");
			return execute({ proposalId: id, expectedVersion: version, ...cmd }).catch((e) => setError(e.message));
		},
		[execute, id, version],
	);
	if (!p) return <p role="alert">Proposal unavailable.</p>;
	const mission = view.missions.find((m) => m.id === p.missionId),
		intent = view.intents.find((i) => i.id === mission?.intentId);
	const verifications = view.verifications.filter((v) => v.proposalId === p.id);
	const deployments = view.deployments.filter((d) => d.proposalId === p.id);
	const reviews = view.reviews.filter((r) => r.proposalId === p.id);
	const production = view.environments.find((e) => e.kind === "production");
	const preview = view.environments.find((e) => e.kind === "preview");
	const open = p.state === "proposed";
	const exactEvidence = (detail?.evidence ?? []).filter((a) => a.revision === p.revision);
	return (
		<section className="workstream-detail" aria-labelledby="proposal-title">
			<p className="eyebrow">
				Proposal #{p.number} · {READINESS_LABEL[p.readiness.outcome]}
			</p>
			<h1 id="proposal-title">{p.summary}</h1>
			<p className="muted">
				{intent && <a href={href({ view: "intent", id: intent.id })}>Intent: {intent.title}</a>}
				{mission && (
					<>
						{" · "}
						<a href={href({ view: "mission", id: mission.id })}>Mission: {mission.title}</a>
						{mission.agent && ` · by ${mission.agent.tool}`}
					</>
				)}
			</p>
			<dl className="kv">
				<dt>Base revision</dt>
				<dd>
					<code className="rev">{short(p.base)}</code> <span className="muted">accepted source</span>
				</dd>
				<dt>Proposed revision</dt>
				<dd>
					<code className="rev" title={p.revision}>
						{short(p.revision)}
					</code>{" "}
					<span className="muted">{p.repository}</span>
				</dd>
				<dt>Changes</dt>
				<dd>
					{p.files} files · {p.commits} commits
					{detail && (
						<span className="muted">
							{" "}
							· +{detail.changes.additions} −{detail.changes.deletions}
						</span>
					)}
				</dd>
				<dt>Risk</dt>
				<dd>
					{p.risk}
					{p.impact && <span className="muted"> · {p.impact}</span>}
				</dd>
			</dl>
			{p.risks.length > 0 && (
				<ul className="plain-list">
					{p.risks.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}

			<h2>Verification of {short(p.revision)}</h2>
			<VerificationList verifications={verifications} required={view.policy.requiredEvidence} missing={p.readiness.missing} />
			{(detail?.verificationRequests.length ?? 0) > 0 && (
				<p className="muted">
					Requested:{" "}
					{detail!.verificationRequests
						.flatMap((r) => r.kinds)
						.map(label)
						.join(", ")}
				</p>
			)}
			{deployments.length > 0 && <Previews deployments={deployments} view={view} />}
			{open && view.permissions.contribute && exactEvidence.length > 0 && <Attest evidence={exactEvidence} act={act} />}

			<h2>Commits and changed files</h2>
			{detail ? (
				<>
					<ul className="plain-list mono">
						{detail.commits.map((c) => (
							<li key={c.oid}>
								<code className="rev">{short(c.oid)}</code> {c.message}
							</li>
						))}
					</ul>
					<ul className="file-list">
						{detail.changes.files.map((f) => (
							<li key={f.path}>
								<button
									type="button"
									className="link-button"
									aria-expanded={file?.path === f.path}
									onClick={() => {
										if (file?.path === f.path) return setFile(null);
										void execute({ tool: "get_diff", proposalId: p.id, path: f.path })
											.then((d) => setFile((d as { file: { path: string; patch: string | null; reason?: string } }).file))
											.catch((e) => setError(e.message));
									}}
								>
									<span className={`file-status ${f.status}`}>{f.status[0].toUpperCase()}</span> {f.path}
								</button>
								<span className="muted">
									{f.additions !== null && ` +${f.additions} −${f.deletions}`}
									{f.binary && " binary"}
								</span>
								{file?.path === f.path && <pre className="patch">{file.patch ?? file.reason ?? "Patch unavailable"}</pre>}
							</li>
						))}
					</ul>
				</>
			) : (
				<p className="muted">Loading exact Git state…</p>
			)}

			<h2>Resource impact</h2>
			<dl className="kv">
				<dt>Local</dt>
				<dd>{view.resourceImpact.local.label}</dd>
				<dt>Worker preview</dt>
				<dd>
					{preview ? (
						<>
							{view.resourceImpact.preview.label} · <span className="muted">{view.resourceImpact.preview.reason}</span>
						</>
					) : (
						<span className="muted">Not configured</span>
					)}
				</dd>
				<dt>Production</dt>
				<dd>
					{production ? view.resourceImpact.production.label : "Not configured"} · <span className="muted">Human approval required</span>
				</dd>
			</dl>
			{open &&
				preview &&
				view.permissions.contribute &&
				!deployments.some((d) => d.environmentId === preview.id && d.revision === p.revision && d.state !== "failed") && (
					<button type="button" className="btn quiet" onClick={() => void act({ tool: "request_preview" })}>
						Request Worker preview
					</button>
				)}

			{reviews.length > 0 && (
				<>
					<h2>Reviews</h2>
					{reviews.map((r) => (
						<div key={r.id} className="evidence-row">
							<strong>
								{r.actorKind} {r.outcome}
							</strong>{" "}
							{r.summary}
							{r.revision !== p.revision && <span className="muted"> (earlier revision)</span>}
							{r.outcome !== "approve" && !r.resolved && open && view.permissions.govern && (
								<button
									type="button"
									className="btn quiet"
									disabled={!reason.trim()}
									onClick={() => void act({ tool: "resolve_review", reviewId: r.id, reason })}
								>
									Resolve with the reason below
								</button>
							)}
							{r.resolved && <span className="muted"> · resolved: {r.resolved.reason}</span>}
						</div>
					))}
				</>
			)}

			<h2>Decision</h2>
			{p.readiness.reasons.length > 0 && (
				<ul className="plain-list">
					{p.readiness.reasons.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}
			{open && view.permissions.contribute && (
				<div className="decision">
					<label>
						Reason
						<textarea maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you decided this" />
					</label>
					<div className="review-actions">
						<button
							type="button"
							className="btn quiet"
							disabled={!reason.trim()}
							onClick={() => void act({ tool: "review_proposal", outcome: "approve", summary: reason })}
						>
							Approve revision
						</button>
						<button
							type="button"
							className="btn quiet"
							disabled={!reason.trim()}
							onClick={() => void act({ tool: "review_proposal", outcome: "concern", summary: reason })}
						>
							Raise a concern
						</button>
						{view.permissions.govern && (
							<>
								<button
									type="button"
									className="btn quiet"
									disabled={!reason.trim()}
									onClick={() => void act({ tool: "decide_proposal", decision: "reject", reason })}
								>
									Reject
								</button>
								<button
									type="button"
									className="btn quiet"
									disabled={!reason.trim()}
									onClick={() => void act({ tool: "decide_proposal", decision: "request_changes", reason })}
								>
									Request changes
								</button>
								<button
									type="button"
									className="btn"
									disabled={p.readiness.outcome !== "READY"}
									onClick={() => void act({ tool: "promote_proposal" })}
								>
									Promote
								</button>
								{production?.target.type === "cloudflare_worker" && (
									<button
										type="button"
										className="btn"
										disabled={p.readiness.outcome !== "READY"}
										onClick={() => void act({ tool: "promote_proposal", deploy: true })}
									>
										Promote and deploy to production
									</button>
								)}
							</>
						)}
					</div>
					<p className="muted">
						Promotion moves accepted source to {short(p.revision)}. Production deployment is a separate, explicit choice.
					</p>
				</div>
			)}
			{p.decision && (
				<p>
					{p.decision.outcome === "reject" ? "Rejected" : "Changes requested"} by {p.decision.actor}: {p.decision.reason}
				</p>
			)}
			{p.supersededBy && (
				<p>
					Superseded by <a href={href({ view: "proposal", id: p.supersededBy })}>{p.supersededBy}</a>
				</p>
			)}
			<p>
				<a href={href({ view: "lineage", subject: p.id })}>Trace lineage</a>
			</p>
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

function VerificationList({ verifications, required, missing }: { verifications: Verification[]; required: string[]; missing: string[] }) {
	return (
		<ul className="verification-list">
			{verifications.map((v) => (
				<li key={v.id}>
					<span className={`outcome ${v.outcome}`}>{v.outcome === "pass" ? "✓" : v.outcome === "fail" ? "✗" : "?"}</span> {label(v.kind)}{" "}
					<span className="muted">
						· {TRUST_LABEL[v.trust]} · {v.actor} · <code>{short(v.revision)}</code>
						{v.summary && ` · ${v.summary}`}
					</span>
				</li>
			))}
			{missing.map((kind) => (
				<li key={`missing-${kind}`}>
					<span className="outcome pending">○</span> {label(kind)} <span className="muted">· required; trusted evidence missing</span>
				</li>
			))}
			{verifications.length === 0 && missing.length === 0 && required.length === 0 && <li className="muted">No verification required.</li>}
		</ul>
	);
}

function Previews({ deployments, view }: { deployments: Deployment[]; view: View }) {
	return (
		<ul className="verification-list">
			{deployments.map((d) => {
				const env = view.environments.find((e) => e.id === d.environmentId);
				return (
					<li key={d.id}>
						<span className={`outcome ${d.state === "deployed" ? "pass" : d.state === "failed" ? "fail" : "pending"}`}>
							{d.state === "deployed" ? "✓" : d.state === "failed" ? "✗" : "○"}
						</span>{" "}
						{env?.name ?? "Environment"} {label(d.state)}{" "}
						<span className="muted">
							· <code>{short(d.revision)}</code>
							{d.url && (
								<>
									{" · "}
									<a href={d.url} rel="noreferrer" target="_blank">
										{new URL(d.url).host}
									</a>
								</>
							)}
							{d.error && ` · ${d.error}`}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

function Attest({ evidence, act }: { evidence: Artifact[]; act: (cmd: Parameters<Execute>[0]) => Promise<unknown> }) {
	const [artifact, setArtifact] = useState(evidence[0]?.id ?? ""),
		[kind, setKind] = useState<Verification["kind"]>("tests"),
		[summary, setSummary] = useState("");
	return (
		<details>
			<summary>Attest evidence for this exact revision</summary>
			<form
				onSubmit={(e) => {
					e.preventDefault();
				}}
			>
				<label>
					Evidence
					<select value={artifact} onChange={(e) => setArtifact(e.target.value)}>
						{evidence.map((a) => (
							<option key={a.id} value={a.id}>
								{label(a.kind)} · {a.title} ({TRUST_LABEL[a.trust]})
							</option>
						))}
					</select>
				</label>
				<label>
					Verification
					<select value={kind} onChange={(e) => setKind(e.target.value as Verification["kind"])}>
						{(["tests", "static_analysis", "security", "architecture", "benchmark"] as const).map((k) => (
							<option key={k} value={k}>
								{label(k)}
							</option>
						))}
					</select>
				</label>
				<label>
					What you inspected
					<input value={summary} onChange={(e) => setSummary(e.target.value)} />
				</label>
				<div className="review-actions">
					<button
						type="button"
						className="btn quiet"
						onClick={() => void act({ tool: "attach_evidence", verificationKind: kind, outcome: "pass", related: [artifact], summary })}
					>
						Attest pass
					</button>
					<button
						type="button"
						className="btn quiet"
						onClick={() => void act({ tool: "attach_evidence", verificationKind: kind, outcome: "fail", related: [artifact], summary })}
					>
						Record failure
					</button>
				</div>
			</form>
		</details>
	);
}
