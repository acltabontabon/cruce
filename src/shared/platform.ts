import { z } from "zod";
import { FlightPlanInput } from "../core/domain.ts";
import { CommandInput, type Principal, WorkspaceInput } from "./coordination.ts";

export const ArtifactKinds = [
	"source",
	"plan",
	"tests",
	"test_report",
	"build",
	"dependency_analysis",
	"migration_plan",
	"architecture",
	"api_specification",
	"logs",
	"benchmark",
	"screenshot",
	"deployment_plan",
	"security_scan",
	"summary",
	"documentation",
	"rollout_evidence",
	"validation",
] as const;
export const Specializations = [
	"implementation",
	"architecture",
	"security",
	"test",
	"migration",
	"review",
	"performance",
	"incident",
	"investigation",
] as const;
export const PLATFORM_TOOLS = [
	"create_intent",
	"create_mission",
	"accept_mission",
	"publish_artifact",
	"publish_source",
	"create_proposal",
	"attach_verification",
	"review_proposal",
	"resolve_review",
	"request_approval",
	"promote_proposal",
	"rollback",
	"get_lineage",
	"get_source",
	"get_diff",
	"get_history",
	"inspect_policy",
	"set_policy",
	"read_artifact",
] as const;
export type Actor = Principal & { kind: "human" | "agent" | "runtime" };
export interface Intent {
	id: string;
	version: number;
	title: string;
	context: string;
	why: string;
	owner: string;
	at: number;
}
export interface Mission {
	id: string;
	version: number;
	intentId: string;
	title: string;
	specialization: (typeof Specializations)[number];
	plan: z.output<typeof FlightPlanInput>;
	workstreamId?: string;
	state: "ready" | "active" | "completed";
	at: number;
}
export interface Artifact {
	id: string;
	kind: (typeof ArtifactKinds)[number];
	missionId: string;
	intentId: string;
	title: string;
	summary: string;
	revision: string;
	parentRevision: string;
	contentHash: string;
	storage: { repository: string; path?: string; revision: string };
	producer: { actor: string; kind: Actor["kind"]; sessionId?: string; tool?: string; model?: string };
	environment: string;
	related: string[];
	trust: "reported" | "verified";
	at: number;
}
export interface Proposal {
	id: string;
	version: number;
	missionId: string;
	artifactId: string;
	summary: string;
	impact: string;
	risks: string[];
	questions: string[];
	risk: "low" | "medium" | "high";
	base: string;
	revision: string;
	policyVersion: number;
	state: "proposed" | "promoting" | "promoted";
	at: number;
}
export interface Verification {
	id: string;
	proposalId: string;
	revision: string;
	kind: "tests" | "static_analysis" | "security" | "architecture" | "benchmark" | "human_review";
	outcome: "pass" | "fail" | "inconclusive";
	artifactIds: string[];
	summary: string;
	actor: string;
	trust: "reported" | "human_attested" | "runtime_verified";
	at: number;
}
export interface Review {
	id: string;
	proposalId: string;
	revision: string;
	policyVersion: number;
	actor: string;
	actorKind: Actor["kind"];
	outcome: "approve" | "concern" | "disagree";
	summary: string;
	resolved?: { actor: string; reason: string; at: number };
	at: number;
}
export interface Promotion {
	id: string;
	proposalId: string;
	from: string;
	to: string;
	actor: string;
	proposalVersion: number;
	policyVersion: number;
	evidenceIds: string[];
	reviewIds: string[];
	coordinationFingerprint?: string;
	state: "prepared" | "complete";
	at: number;
	completedAt?: number;
}
export interface PromotionPolicy {
	version: number;
	humanApproval: boolean;
	approvals: number;
	requiredEvidence: Verification["kind"][];
	agentPromotion: false;
}
export interface PlatformState {
	counter: number;
	version: number;
	intents: Intent[];
	missions: Mission[];
	artifacts: Artifact[];
	proposals: Proposal[];
	verifications: Verification[];
	reviews: Review[];
	promotions: Promotion[];
	policy: PromotionPolicy;
	replays: Record<string, { request: string; result: unknown }>;
	timeline: { id: string; at: number; actor: string; kind: string; ids: string[]; summary: string }[];
}
export interface PromotionReadiness {
	outcome: "READY" | "NEEDS_ATTENTION" | "VERIFY" | "REFRESH";
	reasons: string[];
	evidence: { kind: Verification["kind"]; trust: Verification["trust"]; outcome: Verification["outcome"] }[];
}
const path = z
	.string()
	.min(1)
	.max(400)
	.refine(
		(p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every((s) => s && s !== "." && s !== ".."),
		"Relative source path required",
	);
export const PlatformCommandInput = z
	.object({
		tool: z.enum(PLATFORM_TOOLS),
		systemId: z.string().min(1).max(300),
		idempotencyKey: z.string().min(1).max(200).optional(),
		expectedVersion: z.number().int().nonnegative().optional(),
		workspace: WorkspaceInput.optional(),
		agent: CommandInput.shape.agent,
		expectedPlanVersion: z.number().int().nonnegative().optional(),
		intentId: z.string().max(100).optional(),
		missionId: z.string().max(100).optional(),
		proposalId: z.string().max(100).optional(),
		artifactId: z.string().max(100).optional(),
		reviewId: z.string().max(100).optional(),
		sessionId: z.string().max(100).optional(),
		title: z.string().max(200).optional(),
		context: z.string().max(4000).optional(),
		why: z.string().max(1000).optional(),
		summary: z.string().max(2000).optional(),
		impact: z.string().max(2000).optional(),
		risks: z.array(z.string().max(400)).max(20).optional(),
		questions: z.array(z.string().max(400)).max(20).optional(),
		risk: z.enum(["low", "medium", "high"]).default("medium"),
		specialization: z.enum(Specializations).default("implementation"),
		plan: FlightPlanInput.optional(),
		kind: z.enum(ArtifactKinds).optional(),
		content: z.string().max(100000).optional(),
		related: z.array(z.string().max(100)).max(50).default([]),
		model: z.string().max(100).optional(),
		environment: z.string().max(200).optional(),
		revision: z.string().max(64).optional(),
		base: z.string().max(64).optional(),
		path: path.optional(),
		files: z
			.record(path, z.string().max(100000).nullable())
			.refine(
				(files) => Object.keys(files).length <= 250 && new TextEncoder().encode(JSON.stringify(files)).length <= 4 * 1024 * 1024,
				"Bounded source publication exceeded",
			)
			.optional(),
		verificationKind: z.enum(["tests", "static_analysis", "security", "architecture", "benchmark", "human_review"]).optional(),
		outcome: z.enum(["pass", "fail", "inconclusive", "approve", "concern", "disagree"]).optional(),
		reason: z.string().max(1000).optional(),
		policy: z
			.object({
				approvals: z.number().int().min(1).max(10),
				requiredEvidence: z
					.array(z.enum(["tests", "static_analysis", "security", "architecture", "benchmark", "human_review"]))
					.min(1)
					.max(6),
			})
			.strict()
			.optional(),
	})
	.strict();
export type PlatformCommand = z.infer<typeof PlatformCommandInput>;
export const PLATFORM_READ_TOOLS = new Set([
	"request_approval",
	"get_lineage",
	"get_source",
	"get_diff",
	"get_history",
	"inspect_policy",
	"read_artifact",
]);
