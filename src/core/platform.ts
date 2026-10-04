import type { Actor, Artifact, PlatformCommand, PlatformState, Promotion, PromotionReadiness, Verification } from "../shared/platform.ts";
import { CoordinationError, stable } from "./workstreams.ts";
export const initialPlatform = (): PlatformState => ({
	counter: 0,
	version: 0,
	intents: [],
	missions: [],
	artifacts: [],
	proposals: [],
	verifications: [],
	reviews: [],
	promotions: [],
	policy: { version: 1, humanApproval: true, approvals: 1, requiredEvidence: ["tests"], agentPromotion: false },
	replays: {},
	timeline: [],
});
export class PlatformController {
	readonly state: PlatformState;
	constructor(
		state: PlatformState,
		readonly now: number,
	) {
		this.state = structuredClone(state);
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
	readiness(id: string, canonical: string): PromotionReadiness {
		const p = this.proposal(id),
			evidence = this.state.verifications.filter((v) => v.proposalId === id && v.revision === p.revision);
		const reviews = this.state.reviews.filter(
			(r) => r.proposalId === id && r.revision === p.revision && r.policyVersion === this.state.policy.version,
		);
		const reasons: string[] = [];
		if (p.base !== canonical) reasons.push("Source baseline changed; refresh and verify a new proposal");
		if (p.policyVersion !== this.state.policy.version) reasons.push("Policy changed; re-evaluate this proposal");
		const latestEvidence = evidence.filter(
			(v, position) => !evidence.slice(position + 1).some((other) => other.kind === v.kind && other.actor === v.actor),
		);
		if (latestEvidence.some((v) => v.outcome === "fail")) reasons.push("Applicable verification failed");
		for (const kind of this.state.policy.requiredEvidence)
			if (!latestEvidence.some((v) => v.kind === kind && v.outcome === "pass" && v.trust !== "reported"))
				reasons.push(`Trusted ${kind} evidence required; agent assertions remain reported evidence`);
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
			evidence: latestEvidence.map((v) => ({ kind: v.kind, trust: v.trust, outcome: v.outcome })),
		};
	}
	artifact(a: Omit<Artifact, "id" | "at">) {
		const artifact = { ...a, id: this.next("A"), at: this.now };
		this.state.artifacts.push(artifact);
		this.event(a.producer.actor, "artifact", [a.intentId, a.missionId, artifact.id], a.title);
		return artifact;
	}
	execute(cmd: PlatformCommand, actor: Actor, canonical: string): unknown {
		if (cmd.tool === "inspect_policy") return this.state.policy;
		if (cmd.tool === "request_approval") return this.readiness(cmd.proposalId ?? "", canonical);
		if (cmd.tool === "get_lineage")
			return {
				intents: this.state.intents,
				missions: this.state.missions,
				artifacts: this.state.artifacts,
				proposals: this.state.proposals,
				verifications: this.state.verifications,
				reviews: this.state.reviews,
				promotions: this.state.promotions,
				timeline: this.state.timeline,
			};
		return this.replay(cmd, actor, () => {
			if (cmd.tool === "set_policy") {
				if (actor.kind !== "human" || !actor.maintainer || !cmd.policy || !cmd.reason?.trim())
					throw new CoordinationError(403, "Human maintainer policy decision and reason required");
				if (cmd.expectedVersion !== this.state.policy.version) throw new CoordinationError(409, "Policy changed");
				if (this.state.promotions.some((p) => p.state === "prepared"))
					throw new CoordinationError(409, "Resolve prepared promotion before changing policy");
				this.state.policy = { ...cmd.policy, version: this.state.policy.version + 1, humanApproval: true, agentPromotion: false };
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
				const m = {
					id: this.next("M"),
					version: 1,
					intentId: cmd.intentId!,
					title: cmd.title ?? cmd.plan.summary,
					specialization: cmd.specialization,
					plan: cmd.plan,
					state: "ready" as const,
					at: this.now,
				};
				this.state.missions.push(m);
				this.event(actor.developerId, "mission", [m.intentId, m.id], m.title);
				return m;
			}
			if (cmd.tool === "create_proposal") {
				const m = this.mission(cmd.missionId),
					a = this.state.artifacts.find(
						(a) => a.id === cmd.artifactId && a.missionId === m.id && a.kind === "source" && a.trust === "verified",
					);
				if (!a) throw new CoordinationError(409, "Verified source artifact required");
				const p = {
					id: this.next("P"),
					version: 1,
					missionId: m.id,
					artifactId: a.id,
					summary: cmd.summary ?? a.summary,
					impact: cmd.impact ?? "",
					risks: cmd.risks ?? [],
					questions: cmd.questions ?? [],
					risk: cmd.risk,
					base: a.parentRevision,
					revision: a.revision,
					policyVersion: this.state.policy.version,
					state: "proposed" as const,
					at: this.now,
				};
				this.state.proposals.push(p);
				this.event(actor.developerId, "proposal", [m.intentId, m.id, a.id, p.id], p.summary);
				return p;
			}
			const p = this.proposal(cmd.proposalId);
			if (cmd.expectedVersion !== p.version) throw new CoordinationError(409, "Proposal changed; inspect its current evidence");
			if (p.state !== "proposed") throw new CoordinationError(409, "Proposal is frozen during and after promotion");
			if (cmd.tool === "attach_verification") {
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
				if (actor.kind !== "human" || !actor.maintainer || !cmd.reason?.trim())
					throw new CoordinationError(403, "Human maintainer decision and reason required");
				const r = this.state.reviews.find((r) => r.id === cmd.reviewId && r.proposalId === p.id && !r.resolved);
				if (!r) throw new CoordinationError(409, "Review changed");
				r.resolved = { actor: actor.developerId, reason: cmd.reason, at: this.now };
				p.version++;
				this.event(actor.developerId, "decision", [p.id, r.id], cmd.reason);
				return r;
			}
			throw new CoordinationError(400, "Command requires the native application adapter");
		});
	}
	preparePromotion(cmd: PlatformCommand, actor: Actor, canonical: string): Promotion {
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
		const t = {
			id: this.next("PM"),
			proposalId: p.id,
			from: canonical,
			to: p.revision,
			actor: actor.developerId,
			proposalVersion: p.version,
			policyVersion: this.state.policy.version,
			evidenceIds: this.state.verifications.filter((v) => v.proposalId === p.id && v.revision === p.revision).map((v) => v.id),
			reviewIds: this.state.reviews
				.filter((r) => r.proposalId === p.id && r.revision === p.revision && r.policyVersion === this.state.policy.version)
				.map((r) => r.id),
			state: "prepared" as const,
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
		this.proposal(t.proposalId).state = "promoted";
		this.event(t.actor, "promotion", [t.proposalId, t.id], "Accepted source revision promoted; deployment is separately governed");
		return t;
	}
}
