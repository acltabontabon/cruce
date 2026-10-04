import type {
	Actor,
	Artifact,
	Deployment,
	Environment,
	PlatformCommand,
	PlatformState,
	Promotion,
	PromotionReadiness,
	Proposal,
	ResourceRequest,
	Verification,
	VerificationKind,
} from "../shared/platform.ts";
import {
	DEFAULT_RESOURCE_POLICY,
	evaluateResource,
	normalizeResourcePolicy,
	RESOURCE_COST,
	RESOURCE_LABELS,
	type ResourceAction,
	type ResourceEvaluation,
	recordUsage,
} from "./capabilities.ts";
import { CoordinationError, stable } from "./workstreams.ts";

export const initialPlatform = (): PlatformState => ({
	counter: 0,
	version: 0,
	intents: [],
	missions: [],
	artifacts: [],
	proposals: [],
	verificationRequests: [],
	verifications: [],
	reviews: [],
	promotions: [],
	resourceRequests: [],
	environments: [],
	deployments: [],
	usage: {},
	policy: {
		version: 1,
		humanApproval: true,
		approvals: 1,
		requiredEvidence: ["tests"],
		agentPromotion: false,
		resources: structuredClone(DEFAULT_RESOURCE_POLICY),
	},
	replays: {},
	timeline: [],
});

/** Upgrade state stored by earlier versions without reinterpreting its records. */
export function migratePlatform(stored: PlatformState): PlatformState {
	const s = structuredClone(stored) as PlatformState & Record<string, unknown>;
	const base = initialPlatform();
	for (const key of ["verificationRequests", "resourceRequests", "environments", "deployments"] as const) s[key] ??= [];
	s.usage ??= {};
	s.policy = { ...base.policy, ...s.policy, resources: s.policy?.resources ?? base.policy.resources };
	s.proposals.forEach((p, i) => {
		p.number ??= i + 1;
		p.repository ??= "";
		p.commits ??= 1;
		p.files ??= 0;
	});
	for (const a of s.artifacts as (Artifact & { environment?: string })[]) {
		a.execution ??= { location: "external", detail: a.environment ?? "unspecified" };
		delete a.environment;
	}
	return s;
}

const CLOSED: Proposal["state"][] = ["promoted", "rejected", "changes_requested", "superseded"];

export class PlatformController {
	readonly state: PlatformState;
	constructor(
		state: PlatformState,
		readonly now: number,
	) {
		this.state = migratePlatform(state);
	}
	next(prefix: string) {
		return `${prefix}-${++this.state.counter}`;
	}
	event(actor: string, kind: string, ids: string[], summary: string) {
		this.state.version++;
		this.state.timeline.push({ id: this.next("E"), at: this.now, actor, kind, ids, summary });
	}
	proposal(id?: string) {
		const p = this.state.proposals.find((p) => p.id === id);
		if (!p) throw new CoordinationError(404, "Proposal unavailable");
		return p;
	}
	mission(id?: string) {
		const m = this.state.missions.find((m) => m.id === id);
		if (!m) throw new CoordinationError(404, "Mission unavailable");
		return m;
	}
	environment(id?: string) {
		const e = this.state.environments.find((e) => e.id === id);
		if (!e) throw new CoordinationError(404, "Environment unavailable");
		return e;
	}
	deployment(id?: string) {
		const d = this.state.deployments.find((d) => d.id === id);
		if (!d) throw new CoordinationError(404, "Deployment unavailable");
		return d;
	}
	replay(cmd: PlatformCommand, actor: Actor, run: () => unknown) {
		if (!cmd.idempotencyKey) throw new CoordinationError(400, "Mutation requires an idempotency key");
		const key = `${actor.developerId}:${actor.kind}:${cmd.idempotencyKey}`,
			request = stable(cmd),
			old = this.state.replays[key];
		if (old) {
			if (old.request !== request) throw new CoordinationError(409, "Idempotency key reused with different inputs");
			return old.result;
		}
		if (actor.canWrite === false) throw new CoordinationError(403, "Contribution permission required");
		const result = run();
		this.state.replays[key] = { request, result };
		return result;
	}
	private human(actor: Actor, reason: string) {
		if (actor.kind !== "human" || !actor.maintainer) throw new CoordinationError(403, reason);
	}
	/** Latest result per verification kind and verifier, on the proposal's exact revision. */
	private latestEvidence(p: Proposal) {
		const evidence = this.state.verifications.filter((v) => v.proposalId === p.id && v.revision === p.revision);
		return evidence.filter(
			(v, position) => !evidence.slice(position + 1).some((other) => other.kind === v.kind && other.actor === v.actor),
		);
	}
	readiness(id: string, canonical: string): PromotionReadiness {
		const p = this.proposal(id),
			latest = this.latestEvidence(p);
		const summary = latest.map((v) => ({ kind: v.kind, trust: v.trust, outcome: v.outcome }));
		const missing = this.state.policy.requiredEvidence.filter(
			(kind) => !latest.some((v) => v.kind === kind && v.outcome === "pass" && v.trust !== "reported"),
		);
		if (CLOSED.includes(p.state))
			return {
				outcome: "CLOSED",
				reasons: [
					p.state === "promoted"
						? "Promoted to accepted source"
						: p.state === "superseded"
							? `Superseded by ${p.supersededBy}`
							: `${p.state === "rejected" ? "Rejected" : "Changes requested"}: ${p.decision?.reason ?? ""}`,
				],
				evidence: summary,
				missing,
			};
		const reviews = this.state.reviews.filter(
			(r) => r.proposalId === id && r.revision === p.revision && r.policyVersion === this.state.policy.version,
		);
		const reasons: string[] = [];
		if (p.base !== canonical) reasons.push("Source baseline changed; refresh and verify a new proposal");
		if (p.policyVersion !== this.state.policy.version) reasons.push("Policy changed; re-evaluate this proposal");
		if (latest.some((v) => v.outcome === "fail")) reasons.push("Applicable verification failed");
		for (const kind of missing) reasons.push(`Trusted ${kind} evidence required; agent assertions remain reported evidence`);
		if (reviews.some((r) => r.outcome !== "approve" && !r.resolved))
			reasons.push("Review disagreement or concern requires an explicit decision");
		const approvals = new Set(
			reviews
				.filter(
					(r, position) =>
						r.actorKind === "human" && r.outcome === "approve" && !reviews.slice(position + 1).some((other) => other.actor === r.actor),
				)
				.map((r) => r.actor),
		);
		if (this.state.policy.humanApproval && approvals.size < this.state.policy.approvals) reasons.push("Human approval required");
		if (p.questions.length) reasons.push("Unresolved questions must be addressed in a new proposal");
		return {
			outcome:
				p.base !== canonical
					? "REFRESH"
					: reasons.some((r) => r.includes("disagreement") || r.includes("failed"))
						? "NEEDS_ATTENTION"
						: reasons.length
							? "VERIFY"
							: "READY",
			reasons,
			evidence: summary,
			missing,
		};
	}
	artifact(a: Omit<Artifact, "id" | "at">) {
		const artifact = { ...a, id: this.next("A"), at: this.now };
		this.state.artifacts.push(artifact);
		this.event(a.producer.actor, "artifact", [a.intentId, a.missionId, artifact.id], a.title);
		return artifact;
	}

	// ── resources ────────────────────────────────────────────────────────

	evaluate(action: ResourceAction, actor: Actor, missionId?: string): ResourceEvaluation {
		return evaluateResource(this.state.policy.resources, this.state.usage, { action, missionId, actorKind: actor.kind }, this.now);
	}
	/**
	 * Gate a resource action. Returns undefined when it may run now (usage is charged), a pending
	 * request when a human must approve, and throws when policy denies it.
	 */
	gate(
		action: ResourceAction,
		actor: Actor,
		subject: { missionId?: string; proposalId?: string; environmentId?: string; revision?: string },
	): ResourceRequest | undefined {
		const evaluation = this.evaluate(action, actor, subject.missionId);
		if (evaluation.outcome === "deny") throw new CoordinationError(403, evaluation.reason);
		if (evaluation.outcome === "allow") {
			this.charge(action, actor, subject.missionId);
			return undefined;
		}
		const matching = this.state.resourceRequests.filter(
			(r) =>
				r.action === action && r.proposalId === subject.proposalId && r.missionId === subject.missionId && r.revision === subject.revision,
		);
		// A human already approved this exact action: run it once, then the approval is spent.
		const approved = matching.find((r) => r.state === "approved");
		if (approved) {
			approved.state = "executed";
			return undefined;
		}
		const existing = matching.find((r) => r.state === "pending");
		if (existing) return existing;
		const request: ResourceRequest = {
			id: this.next("RR"),
			action,
			cost: RESOURCE_COST[action],
			...subject,
			requestedBy: actor.developerId,
			actorKind: actor.kind,
			reason: evaluation.reason,
			state: "pending",
			at: this.now,
		};
		this.state.resourceRequests.push(request);
		this.event(
			actor.developerId,
			"resource_request",
			[subject.proposalId ?? subject.missionId ?? "", request.id],
			`${RESOURCE_LABELS[action]}: approval required`,
		);
		return request;
	}
	charge(action: ResourceAction, actor: Actor, missionId?: string) {
		this.state.usage = recordUsage(this.state.usage, { action, missionId, actorKind: actor.kind }, this.now);
	}
	decideResourceRequest(cmd: PlatformCommand, actor: Actor) {
		this.human(actor, "Human maintainer decision required for resource consumption");
		const r = this.state.resourceRequests.find((r) => r.id === cmd.requestId);
		if (!r) throw new CoordinationError(404, "Resource request unavailable");
		if (r.state !== "pending") throw new CoordinationError(409, "Resource request already decided");
		if (cmd.decision !== "approve" && cmd.decision !== "deny") throw new CoordinationError(400, "Approve or deny required");
		if (!cmd.reason?.trim()) throw new CoordinationError(400, "Decision reason required");
		r.state = cmd.decision === "approve" ? "approved" : "denied";
		r.decidedBy = actor.developerId;
		r.decision = cmd.reason;
		r.decidedAt = this.now;
		if (r.state === "approved") this.charge(r.action, actor, r.missionId);
		this.event(
			actor.developerId,
			"resource_decision",
			[r.proposalId ?? r.missionId ?? "", r.id],
			`${RESOURCE_LABELS[r.action]}: ${r.state}`,
		);
		return r;
	}

	// ── environments and deployments ─────────────────────────────────────

	addEnvironment(e: Omit<Environment, "id" | "at">, actor: Actor) {
		const existing = this.state.environments.find((x) => x.kind === e.kind);
		if (existing) {
			Object.assign(existing, e);
			this.event(actor.developerId, "environment", [existing.id], `${existing.name} reconfigured`);
			return existing;
		}
		const environment = { ...e, id: this.next("ENV"), at: this.now };
		this.state.environments.push(environment);
		this.event(actor.developerId, "environment", [environment.id], `${environment.name} configured`);
		return environment;
	}
	recordDeployment(d: Omit<Deployment, "id" | "at" | "updatedAt" | "evidenceIds" | "state">, actor: Actor) {
		const deployment: Deployment = { ...d, id: this.next("D"), state: "queued", evidenceIds: [], at: this.now, updatedAt: this.now };
		this.state.deployments.push(deployment);
		const env = this.environment(d.environmentId);
		this.event(actor.developerId, "deployment", [d.proposalId ?? "", deployment.id], `${env.name}: ${d.revision.slice(0, 12)} requested`);
		return deployment;
	}
	updateDeployment(id: string, fields: Partial<Pick<Deployment, "state" | "buildId" | "url" | "error" | "branch">>) {
		const d = this.deployment(id);
		const before = d.state;
		Object.assign(d, fields, { updatedAt: this.now });
		if (fields.state === "deployed")
			for (const other of this.state.deployments)
				if (other.id !== d.id && other.environmentId === d.environmentId && other.state === "deployed") other.state = "superseded";
		if (fields.state && fields.state !== before) {
			const env = this.environment(d.environmentId);
			this.event("cruce", "deployment", [d.proposalId ?? "", d.id], `${env.name}: ${d.revision.slice(0, 12)} ${fields.state}`);
		}
		return d;
	}
	/** Evidence observed by Cruce itself (deployment checks) is runtime verified, unlike agent reports. */
	runtimeVerification(d: Deployment, kind: VerificationKind, outcome: Verification["outcome"], summary: string, artifactIds: string[]) {
		const p = d.proposalId ? this.proposal(d.proposalId) : undefined;
		if (!p || p.revision !== d.revision) return undefined;
		const v: Verification = {
			id: this.next("V"),
			proposalId: p.id,
			revision: d.revision,
			kind,
			outcome,
			artifactIds,
			summary,
			actor: "cruce-runtime",
			trust: "runtime_verified",
			deploymentId: d.id,
			at: this.now,
		};
		this.state.verifications.push(v);
		d.evidenceIds.push(v.id, ...artifactIds);
		if (p.state === "proposed") p.version++;
		this.event("cruce", "verification", [p.id, v.id, d.id], `${kind}: ${outcome} (runtime verified)`);
		return v;
	}

	// ── lineage ──────────────────────────────────────────────────────────

	/** Connected lineage around one subject: intent → mission → revision → artifacts → proposal → verification → deployment, and back. */
	trace(subjectId: string) {
		const s = this.state,
			edges: [string, string][] = [];
		const rev = (r: string) => `rev:${r}`;
		for (const m of s.missions) edges.push([m.intentId, m.id]);
		for (const a of s.artifacts)
			edges.push([a.missionId, a.id], [a.id, rev(a.revision)], ...a.related.map((r) => [a.id, r] as [string, string]));
		for (const p of s.proposals) edges.push([p.missionId, p.id], [p.artifactId, p.id], [p.id, rev(p.revision)]);
		for (const v of s.verifications) edges.push([v.proposalId, v.id], ...v.artifactIds.map((a) => [v.id, a] as [string, string]));
		for (const r of s.reviews) edges.push([r.proposalId, r.id]);
		for (const t of s.promotions) edges.push([t.proposalId, t.id], [t.id, rev(t.to)]);
		for (const d of s.deployments) {
			edges.push([d.id, rev(d.revision)], [d.environmentId, d.id]);
			if (d.proposalId) edges.push([d.proposalId, d.id]);
			if (d.promotionId) edges.push([d.promotionId, d.id]);
		}
		const start = /^[0-9a-f]{40}$/.test(subjectId) ? rev(subjectId) : subjectId;
		const seen = new Set([start]),
			queue = [start];
		while (queue.length) {
			const id = queue.shift()!;
			// Environments connect every deployment; only traverse into them, never through them.
			if (id.startsWith("ENV-") && id !== start) continue;
			for (const [a, b] of edges) {
				const other = a === id ? b : b === id ? a : undefined;
				if (other && !seen.has(other)) {
					seen.add(other);
					queue.push(other);
				}
			}
		}
		const has = (id: string) => seen.has(id);
		return {
			subjectId,
			intents: s.intents.filter((i) => has(i.id)),
			missions: s.missions.filter((m) => has(m.id)),
			revisions: [...seen].filter((id) => id.startsWith("rev:")).map((id) => id.slice(4)),
			artifacts: s.artifacts.filter((a) => has(a.id)),
			proposals: s.proposals.filter((p) => has(p.id)),
			verifications: s.verifications.filter((v) => has(v.id)),
			reviews: s.reviews.filter((r) => has(r.id)),
			promotions: s.promotions.filter((t) => has(t.id)),
			deployments: s.deployments.filter((d) => has(d.id)),
			environments: s.environments.filter((e) => has(e.id)),
		};
	}
	/** Which mission, proposal and intent produced an accepted revision. */
	explainRevision(revision: string) {
		const t = this.state.promotions.find((t) => t.to === revision && t.state === "complete"),
			p = t ? this.state.proposals.find((p) => p.id === t.proposalId) : this.state.proposals.find((p) => p.revision === revision),
			m = p ? this.state.missions.find((m) => m.id === p.missionId) : undefined,
			i = m ? this.state.intents.find((i) => i.id === m.intentId) : undefined;
		return {
			proposal: p ? { id: p.id, number: p.number, summary: p.summary } : undefined,
			mission: m?.title,
			intent: i?.title,
			agent: m?.agent?.tool,
		};
	}

	// ── commands ─────────────────────────────────────────────────────────

	execute(cmd: PlatformCommand, actor: Actor, canonical: string): unknown {
		if (cmd.tool === "get_policy") return this.state.policy;
		if (cmd.tool === "get_lineage") return cmd.subjectId ? this.trace(cmd.subjectId) : this.everything();
		return this.replay(cmd, actor, () => {
			if (cmd.tool === "set_policy") {
				this.human(actor, "Human maintainer policy decision and reason required");
				if (!cmd.policy || !cmd.reason?.trim()) throw new CoordinationError(403, "Human maintainer policy decision and reason required");
				if (cmd.expectedVersion !== this.state.policy.version) throw new CoordinationError(409, "Policy changed");
				if (this.state.promotions.some((p) => p.state === "prepared"))
					throw new CoordinationError(409, "Resolve prepared promotion before changing policy");
				let resources = this.state.policy.resources;
				try {
					if (cmd.policy.resources)
						resources = normalizeResourcePolicy({
							rules: { ...resources.rules, ...cmd.policy.resources.rules },
							budgets: { ...resources.budgets, ...cmd.policy.resources.budgets },
						});
				} catch (error) {
					throw new CoordinationError(400, (error as Error).message);
				}
				this.state.policy = {
					approvals: cmd.policy.approvals,
					requiredEvidence: cmd.policy.requiredEvidence,
					resources,
					version: this.state.policy.version + 1,
					humanApproval: true,
					agentPromotion: false,
				};
				this.event(actor.developerId, "policy", [], cmd.reason);
				return this.state.policy;
			}
			if (cmd.tool === "create_intent") {
				if (!cmd.title?.trim() || !cmd.context?.trim()) throw new CoordinationError(400, "Intent needs a title and context");
				const i = {
					id: this.next("IN"),
					version: 1,
					title: cmd.title,
					context: cmd.context,
					why: cmd.why ?? "",
					owner: actor.developerId,
					at: this.now,
				};
				this.state.intents.push(i);
				this.event(actor.developerId, "intent", [i.id], i.title);
				return i;
			}
			if (cmd.tool === "create_mission") {
				if (!this.state.intents.some((i) => i.id === cmd.intentId) || !cmd.plan)
					throw new CoordinationError(400, "Intent and bounded plan required");
				if (cmd.experimentOf) {
					const original = this.mission(cmd.experimentOf);
					if (original.intentId !== cmd.intentId) throw new CoordinationError(400, "Experiments compare approaches to the same intent");
				}
				const m = {
					id: this.next("M"),
					version: 1,
					intentId: cmd.intentId!,
					title: cmd.title ?? cmd.plan.summary,
					specialization: cmd.specialization,
					plan: cmd.plan,
					experimentOf: cmd.experimentOf ? (this.mission(cmd.experimentOf).experimentOf ?? cmd.experimentOf) : undefined,
					state: "ready" as const,
					at: this.now,
				};
				this.state.missions.push(m);
				this.event(actor.developerId, "mission", [m.intentId, m.id], m.title);
				return m;
			}
			if (cmd.tool === "complete_mission") {
				const m = this.mission(cmd.missionId);
				if (cmd.expectedVersion !== m.version) throw new CoordinationError(409, "Mission changed; refresh context");
				if (m.state === "completed") return m;
				m.state = "completed";
				m.completedAt = this.now;
				m.version++;
				this.event(
					actor.developerId,
					"mission_completed",
					[m.intentId, m.id],
					cmd.summary ?? `${m.title} completed; promotion remains separately governed`,
				);
				return m;
			}
			if (cmd.tool === "create_proposal") {
				const m = this.mission(cmd.missionId),
					a = this.state.artifacts.find(
						(a) => a.id === cmd.artifactId && a.missionId === m.id && a.kind === "source" && a.trust === "verified",
					);
				if (!a) throw new CoordinationError(409, "Verified source artifact required");
				const p: Proposal = {
					id: this.next("P"),
					number: this.state.proposals.length + 1,
					version: 1,
					missionId: m.id,
					artifactId: a.id,
					summary: cmd.summary ?? a.summary,
					impact: cmd.impact ?? "",
					risks: cmd.risks ?? [],
					questions: cmd.questions ?? [],
					risk: cmd.risk,
					base: a.source?.base ?? a.parentRevision,
					revision: a.revision,
					repository: a.storage.repository,
					commits: a.source?.commits.length ?? 1,
					files: a.source?.files ?? 0,
					policyVersion: this.state.policy.version,
					state: "proposed",
					at: this.now,
				};
				for (const old of this.state.proposals.filter(
					(o) => o.missionId === m.id && (o.state === "proposed" || o.state === "changes_requested"),
				)) {
					old.state = "superseded";
					old.supersededBy = p.id;
					old.version++;
				}
				this.state.proposals.push(p);
				this.event(actor.developerId, "proposal", [m.intentId, m.id, a.id, p.id], `#${p.number} ${p.summary}`);
				return p;
			}
			if (cmd.tool === "decide_resource_request") return this.decideResourceRequest(cmd, actor);
			const p = this.proposal(cmd.proposalId);
			if (cmd.expectedVersion !== p.version) throw new CoordinationError(409, "Proposal changed; inspect its current evidence");
			if (p.state !== "proposed") throw new CoordinationError(409, `Proposal is ${p.state.replace("_", " ")}; it can no longer change`);
			if (cmd.tool === "attach_evidence") {
				if (!cmd.verificationKind || !["pass", "fail", "inconclusive"].includes(cmd.outcome ?? ""))
					throw new CoordinationError(400, "Verification kind and result required");
				if (cmd.verificationKind !== "human_review" && !cmd.related.length)
					throw new CoordinationError(400, "Verification requires exact-revision evidence artifacts");
				if (cmd.related.some((id) => !this.state.artifacts.some((a) => a.id === id && a.revision === p.revision)))
					throw new CoordinationError(400, "Evidence must reference artifacts from this exact source revision");
				const v: Verification = {
					id: this.next("V"),
					proposalId: p.id,
					revision: p.revision,
					kind: cmd.verificationKind,
					outcome: cmd.outcome as Verification["outcome"],
					artifactIds: cmd.related,
					summary: cmd.summary ?? "",
					actor: actor.developerId,
					trust: actor.kind === "runtime" ? "runtime_verified" : actor.kind === "human" ? "human_attested" : "reported",
					at: this.now,
				};
				this.state.verifications.push(v);
				p.version++;
				this.event(actor.developerId, "verification", [p.id, v.id], `${v.kind}: ${v.outcome} (${v.trust})`);
				return v;
			}
			if (cmd.tool === "request_verification") {
				const kinds = cmd.verificationKinds ?? this.state.policy.requiredEvidence;
				const r = { id: this.next("VR"), proposalId: p.id, revision: p.revision, kinds, requestedBy: actor.developerId, at: this.now };
				this.state.verificationRequests.push(r);
				p.version++;
				this.event(actor.developerId, "verification_request", [p.id, r.id], `Verify ${p.revision.slice(0, 12)}: ${kinds.join(", ")}`);
				return { request: r, readiness: this.readiness(p.id, canonical) };
			}
			if (cmd.tool === "request_promotion") {
				p.promotionRequestedAt = this.now;
				p.version++;
				const readiness = this.readiness(p.id, canonical);
				this.event(actor.developerId, "promotion_request", [p.id], `Promotion of #${p.number} requested`);
				return { proposalId: p.id, readiness, decision: "Human approval required; agents cannot promote accepted source" };
			}
			if (cmd.tool === "review_proposal") {
				if (!["approve", "concern", "disagree"].includes(cmd.outcome ?? "") || !cmd.summary?.trim())
					throw new CoordinationError(400, "Structured review and reason required");
				const r = {
					id: this.next("R"),
					proposalId: p.id,
					revision: p.revision,
					policyVersion: this.state.policy.version,
					actor: actor.developerId,
					actorKind: actor.kind,
					outcome: cmd.outcome as "approve" | "concern" | "disagree",
					summary: cmd.summary,
					at: this.now,
				};
				this.state.reviews.push(r);
				p.version++;
				this.event(actor.developerId, "review", [p.id, r.id], r.summary);
				return r;
			}
			if (cmd.tool === "resolve_review") {
				this.human(actor, "Human maintainer decision and reason required");
				if (!cmd.reason?.trim()) throw new CoordinationError(403, "Human maintainer decision and reason required");
				const r = this.state.reviews.find((r) => r.id === cmd.reviewId && r.proposalId === p.id && !r.resolved);
				if (!r) throw new CoordinationError(409, "Review changed");
				r.resolved = { actor: actor.developerId, reason: cmd.reason, at: this.now };
				p.version++;
				this.event(actor.developerId, "decision", [p.id, r.id], cmd.reason);
				return r;
			}
			if (cmd.tool === "decide_proposal") {
				this.human(actor, "Human maintainer decision required");
				if ((cmd.decision !== "reject" && cmd.decision !== "request_changes") || !cmd.reason?.trim())
					throw new CoordinationError(400, "Reject or request changes, with a reason");
				p.state = cmd.decision === "reject" ? "rejected" : "changes_requested";
				p.decision = { outcome: cmd.decision, actor: actor.developerId, reason: cmd.reason, at: this.now };
				p.version++;
				this.event(
					actor.developerId,
					"decision",
					[p.id],
					`#${p.number} ${cmd.decision === "reject" ? "rejected" : "changes requested"}: ${cmd.reason}`,
				);
				return p;
			}
			throw new CoordinationError(400, "Command requires the native application adapter");
		});
	}
	everything() {
		const { replays: _r, usage: _u, ...rest } = this.state;
		return rest;
	}
	preparePromotion(cmd: PlatformCommand, actor: Actor, canonical: string, repository: string): Promotion {
		if (actor.kind !== "human" || !actor.maintainer)
			throw new CoordinationError(403, "Human maintainer promotion required; agents cannot promote");
		const p = this.proposal(cmd.proposalId);
		if (cmd.expectedVersion !== p.version) throw new CoordinationError(409, "Proposal changed");
		const existing = this.state.promotions.find((t) => t.proposalId === p.id);
		if (existing) {
			if (existing.actor !== actor.developerId || (canonical !== existing.from && canonical !== existing.to))
				throw new CoordinationError(409, "Prepared promotion inputs changed");
			return existing;
		}
		const readiness = this.readiness(p.id, canonical);
		if (readiness.outcome !== "READY") throw new CoordinationError(409, readiness.reasons.join("; "));
		const t: Promotion = {
			id: this.next("PM"),
			proposalId: p.id,
			from: canonical,
			to: p.revision,
			repository,
			actor: actor.developerId,
			proposalVersion: p.version,
			policyVersion: this.state.policy.version,
			evidenceIds: this.latestEvidence(p).map((v) => v.id),
			reviewIds: this.state.reviews
				.filter((r) => r.proposalId === p.id && r.revision === p.revision && r.policyVersion === this.state.policy.version)
				.map((r) => r.id),
			deploy: cmd.deploy === true,
			state: "prepared",
			at: this.now,
		};
		this.state.promotions.push(t);
		p.state = "promoting";
		this.event(actor.developerId, "promotion_prepared", [p.id, t.id], p.summary);
		return t;
	}
	completePromotion(id: string) {
		const t = this.state.promotions.find((t) => t.id === id);
		if (!t) throw new CoordinationError(404, "Promotion ticket missing");
		if (t.state === "complete") return t;
		t.state = "complete";
		t.completedAt = this.now;
		const p = this.proposal(t.proposalId);
		p.state = "promoted";
		const m = this.state.missions.find((m) => m.id === p.missionId);
		this.event(
			t.actor,
			"promotion",
			[m?.intentId ?? "", p.missionId, t.proposalId, t.id],
			`#${p.number} promoted to accepted source ${t.to.slice(0, 12)}`,
		);
		return t;
	}
}
