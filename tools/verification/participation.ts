import { z } from "zod";
import type { ActivityEvent, Artifact, Promotion, Proposal, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";

const text = z.string().min(1).max(200);
const oid = z.string().regex(/^[0-9a-f]{40}$/);
export const deploymentInput = z.object({ workerVersion: text, sourceRevision: oid }).strict();
export type Deployment = z.infer<typeof deploymentInput>;
export const toolRunInput = z
	.object({
		tool: z.enum(["codex", "claude"]),
		version: text,
		observedBy: text,
		observedAt: z.iso.datetime(),
		workspaceId: text,
		actorId: text,
		connectionId: text,
		revision: oid,
		checkpoint: text,
		machineId: text,
		checkoutId: text,
	})
	.strict();
export const caseNames = [
	"client-response-loss",
	"source-response-loss",
	"evidence-response-loss",
	"promotion-response-loss",
	"cleanup-response-loss",
	"settlement-interruption",
	"cold-cache-recovery",
	"scope-reduction",
	"oauth-revocation",
	"in-flight-revocation",
	"cleanup-revocation",
	"membership-revocation",
	"grant-revocation",
] as const;
export const caseInput = z
	.object({
		name: z.enum(caseNames),
		status: z.enum(["pass", "fail", "unverified"]),
		deployment: deploymentInput,
		checkpoint: text,
		receipt: z
			.string()
			.regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.json$/)
			.refine((p) => !p.split("/").includes("..")),
	})
	.strict();
export const evidenceInput = z
	.object({
		deployment: deploymentInput,
		toolRuns: z.array(toolRunInput),
		secondMachine: z.object({ workspaceId: text, from: text, to: text, confirmedBy: text, checkpoint: text }).strict().optional(),
		cases: z.array(caseInput),
	})
	.strict();
export type ParticipationEvidence = z.infer<typeof evidenceInput>;
export interface Observation {
	at: string;
	label: string;
	deployment?: Deployment;
	canonical: { recorded?: string; remote?: string; integrity?: boolean; providerId?: string };
	workspaces: Pick<Workspace, "id" | "ownerId" | "baseRevision" | "headRevision" | "execution" | "fork" | "state" | "createdBy">[];
	artifacts: Pick<Artifact, "id" | "kind" | "workspaceId" | "actor" | "revision" | "baseRevision" | "storage" | "contentHash">[];
	proposals: (Pick<Proposal, "id" | "workspaceId" | "artifactId" | "base" | "revision" | "state" | "reviews"> & { readiness: string[] })[];
	promotions: Promotion[];
	activity: Pick<ActivityEvent, "id" | "kind" | "ids" | "at" | "actor">[];
	retained?: { artifactId: string; providerId: string; ref: string; revision: string; integrity: boolean; lineage: boolean }[];
	deletedForks?: string[];
	ancestry?: { base: string; revision: string; ancestor: boolean }[];
}
export type Judgement = { invariant: string; status: "pass" | "fail" | "unverified"; detail: string };
const sameDeployment = (a?: Deployment, b?: Deployment) =>
	!!a && !!b && a.workerVersion === b.workerVersion && a.sourceRevision === b.sourceRevision;
export function projectObservation(
	view: RepositorySnapshot,
	activity: ActivityEvent[],
	label: string,
	deployment?: Deployment,
): Observation {
	return {
		at: new Date().toISOString(),
		label,
		deployment,
		canonical: { recorded: view.sourceHead, providerId: view.canonical?.id },
		workspaces: view.workspaces.map(({ id, ownerId, baseRevision, headRevision, execution, fork, state, createdBy }) => ({
			id,
			ownerId,
			baseRevision,
			headRevision,
			execution,
			fork,
			state,
			createdBy,
		})),
		artifacts: view.artifacts.map(({ id, kind, workspaceId, actor, revision, baseRevision, storage, contentHash }) => ({
			id,
			kind,
			workspaceId,
			actor,
			revision,
			baseRevision,
			storage,
			contentHash,
		})),
		proposals: view.proposals.map(({ id, workspaceId, artifactId, base, revision, state, reviews }) => ({
			id,
			workspaceId,
			artifactId,
			base,
			revision,
			state,
			reviews,
			readiness: view.readiness[id]?.reasons ?? [],
		})),
		promotions: view.promotions,
		activity,
	};
}
/** Missing witnesses are unverified. Contradictory observed facts fail. Labels never prove participation. */
export function judgeParticipation(history: Observation[], evidence?: ParticipationEvidence): Judgement[] {
	const results: Judgement[] = [];
	const check = (invariant: string, present: boolean, pass: boolean, detail: string) =>
		results.push({ invariant, status: !present ? "unverified" : pass ? "pass" : "fail", detail });
	const last = history.at(-1);
	const matching = history.filter((o) => sameDeployment(o.deployment, evidence?.deployment));
	check(
		"deployment identified",
		!!last?.deployment && !!evidence,
		sameDeployment(last?.deployment, evidence?.deployment) && matching.length === history.length,
		"Exact Worker version and source revision for every checkpoint",
	);
	const firstSeen = new Map<string, string>();
	for (const o of history) for (const w of o.workspaces) if (!firstSeen.has(w.id)) firstSeen.set(w.id, w.baseRevision);
	check(
		"immutable workspace baselines",
		firstSeen.size > 0,
		history.every((o) => o.workspaces.every((w) => firstSeen.get(w.id) === w.baseRevision)),
		`${firstSeen.size} workspaces`,
	);
	const runs = evidence?.toolRuns ?? [];
	const validRun = (r: (typeof runs)[number]) =>
		matching.some(
			(o) =>
				o.label === r.checkpoint &&
				o.workspaces.some(
					(w) =>
						w.id === r.workspaceId &&
						w.ownerId === r.observedBy &&
						w.execution?.machineId === r.machineId &&
						w.execution.checkoutId === r.checkoutId,
				) &&
				o.artifacts.some(
					(a) =>
						a.kind === "source" &&
						a.workspaceId === r.workspaceId &&
						a.actor.id === r.actorId &&
						a.actor.connectionId === r.connectionId &&
						a.revision === r.revision,
				),
		);
	check(
		"actual Codex and Claude participation",
		runs.length > 0,
		runs.every(validRun) && new Set(runs.map((r) => r.tool)).size === 2 && new Set(runs.map((r) => r.connectionId)).size >= 2,
		"Owner-observed invocations, versions, MCP checkpoints and exact publications",
	);
	const concurrent = history.some((o) => {
		const active = o.workspaces.filter((w) => !!w.execution);
		return active.some((w, i) =>
			active
				.slice(i + 1)
				.some((other) => w.baseRevision === other.baseRevision && w.fork?.id !== other.fork?.id && !!w.fork && !!other.fork),
		);
	});
	check(
		"concurrent independent forks at one baseline",
		!!last?.workspaces.length,
		concurrent,
		"Two attached workspaces with distinct forks",
	);
	const continued = last?.workspaces.find((w) => {
		const events = last.activity.filter((e) => e.ids[0] === w.id);
		const producers = new Set(last.artifacts.filter((a) => a.workspaceId === w.id && a.kind === "source").map((a) => a.actor.connectionId));
		const checkouts = new Set(
			history.flatMap((o) =>
				o.workspaces.filter((s) => s.id === w.id && s.execution).map((s) => `${s.execution!.machineId}:${s.execution!.checkoutId}`),
			),
		);
		return (
			events.filter((e) => e.kind === "execution_attached").length >= 2 &&
			events.some((e) => e.kind === "execution_detached") &&
			producers.size >= 2 &&
			checkouts.size >= 2
		);
	});
	check(
		"detach and cross-connection continuation",
		!!last?.activity.length,
		!!continued,
		continued?.id ?? "No complete continuation witnessed",
	);
	const machine = evidence?.secondMachine;
	check(
		"physical second-machine continuation",
		!!machine,
		!!machine &&
			!!continued &&
			machine.workspaceId === continued.id &&
			machine.confirmedBy === continued.ownerId &&
			machine.from !== machine.to &&
			history.some(
				(o) =>
					o.label === machine.checkpoint && o.workspaces.some((w) => w.id === machine.workspaceId && w.execution?.machineId === machine.to),
			) &&
			history.some((o) => o.workspaces.some((w) => w.id === machine.workspaceId && w.execution?.machineId === machine.from)),
		"Owner confirmation plus host-local execution receipts",
	);
	const complete = last?.promotions.filter((p) => p.state === "complete") ?? [];
	check(
		"two qualified human exact promotions",
		complete.length > 0,
		complete.length >= 2 &&
			complete.every((p) => {
				const proposal = last?.proposals.find((c) => c.id === p.proposalId);
				return (
					p.actor.kind === "human" &&
					!p.actor.connectionId &&
					!!p.operation?.reservationId &&
					proposal?.revision === p.to &&
					proposal.base === p.from &&
					proposal.reviews.some(
						(r) =>
							r.actor.kind === "human" &&
							!r.actor.connectionId &&
							r.approvalAuthority === "human-maintainer" &&
							r.outcome === "approve" &&
							r.revision === p.to,
					)
				);
			}),
		"Approval authority, reviewed base/head and original reservation recorded",
	);
	const reconciled = complete
		.slice(1)
		.find((p) =>
			history.some((o) =>
				o.proposals.some(
					(s) =>
						s.workspaceId === last?.proposals.find((c) => c.id === p.proposalId)?.workspaceId &&
						s.revision !== p.to &&
						s.readiness.some((r) => r.startsWith("Base revision changed")) &&
						o.canonical.recorded === p.from,
				),
			),
		);
	check(
		"stale detection before reconciled promotion",
		complete.length >= 2,
		!!reconciled &&
			history.some((o) => o.ancestry?.some((a) => a.base === reconciled.from && a.revision === reconciled.to && a.ancestor)) &&
			last!.artifacts.some((a) => a.kind === "source" && a.revision === reconciled.to && a.baseRevision === reconciled.from),
		"Stale proposal, pinned review base and independent Git ancestry",
	);
	check(
		"canonical agrees with independent Git",
		!!last?.canonical.remote,
		!!last?.canonical.integrity && last.canonical.remote === last.canonical.recorded && complete.at(-1)?.to === last.canonical.remote,
		"Fresh native Git fetch and fsck",
	);
	check(
		"agents never promoted or qualified approval",
		!!last?.proposals.length,
		last!.promotions.every((p) => p.actor.kind === "human" && !p.actor.connectionId) &&
			last!.proposals.every((p) =>
				p.reviews.every((r) => r.approvalAuthority !== "human-maintainer" || (r.actor.kind === "human" && !r.actor.connectionId)),
			),
		"Informational agent reviews do not qualify",
	);
	check(
		"retained source and provenance after fork cleanup",
		!!last?.retained && !!last.deletedForks,
		last!.workspaces.length >= 2 &&
			last!.workspaces.every((w) => w.fork?.state === "deleted" && last!.deletedForks!.includes(w.fork.id)) &&
			last!.artifacts.length > 0 &&
			last!.artifacts.every((a) =>
				last!.retained!.some(
					(r) =>
						r.artifactId === a.id &&
						r.providerId === a.storage.providerId &&
						r.ref === a.storage.ref &&
						r.revision === a.storage.revision &&
						r.integrity &&
						r.lineage,
				),
			),
		"Independent provider absence checks and every retained ref fetched after cleanup",
	);
	for (const name of caseNames) {
		const cases = evidence?.cases.filter((c) => c.name === name) ?? [];
		const witnessed =
			cases.length === 1 &&
			sameDeployment(cases[0].deployment, evidence?.deployment) &&
			matching.some((o) => o.label === cases[0].checkpoint);
		check(
			name,
			witnessed && cases[0].status !== "unverified",
			witnessed && cases[0].status === "pass",
			witnessed ? cases[0].receipt : "No matching deployed receipt/checkpoint",
		);
	}
	return results;
}
