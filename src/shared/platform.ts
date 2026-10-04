import { z } from "zod";
import { type CostClass, RESOURCE_ACTIONS, type ResourceAction, type ResourcePolicy, type Scope } from "../core/capabilities.ts";
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
	"deployment_manifest",
	"security_scan",
	"sbom",
	"summary",
	"documentation",
	"rollout_evidence",
	"validation",
	"preview_report",
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
export const VerificationKinds = ["tests", "static_analysis", "security", "architecture", "benchmark", "preview", "human_review"] as const;
export type VerificationKind = (typeof VerificationKinds)[number];
/** Where work executed. Source, execution and deployment are separate concepts. */
export const ExecutionLocations = ["local", "cloudflare", "external"] as const;

/** Internal command names. Agents reach a subset through Cruce MCP (see shared/tools.ts). */
export const PLATFORM_TOOLS = [
	// control: read Cruce domain state
	"get_project",
	"get_context",
	"get_mission",
	"get_canonical_revision",
	"get_source",
	"get_diff",
	"get_history",
	"get_proposal",
	"get_lineage",
	"get_policy",
	"read_artifact",
	// lifecycle
	"create_mission",
	"start_mission",
	"publish_revision",
	"publish_artifact",
	"create_proposal",
	"attach_evidence",
	"request_verification",
	"review_proposal",
	"request_preview",
	"request_promotion",
	"complete_mission",
	// human decisions (console only)
	"set_policy",
	"resolve_review",
	"decide_proposal",
	"promote_proposal",
	"decide_resource_request",
	"configure_environment",
	"deploy_revision",
	"plan_rollback",
] as const;
export type PlatformTool = (typeof PLATFORM_TOOLS)[number];
export const PLATFORM_READ_TOOLS = new Set<string>([
	"get_project",
	"get_context",
	"get_mission",
	"get_canonical_revision",
	"get_source",
	"get_diff",
	"get_history",
	"get_proposal",
	"get_lineage",
	"get_policy",
	"read_artifact",
	"plan_rollback",
]);
/** Decisions reserved for humans. Agent connections never reach these, whatever their scopes. */
export const HUMAN_TOOLS = new Set<string>([
	"set_policy",
	"resolve_review",
	"decide_proposal",
	"promote_proposal",
	"decide_resource_request",
	"configure_environment",
	"deploy_revision",
	"plan_rollback",
]);

export type Actor = Principal & { kind: "human" | "agent" | "runtime"; scopes?: Scope[] };

/** The project's canonical Git repository in Cloudflare Artifacts. Remote URLs never carry credentials. */
export interface SourceRepository {
	backend: "cloudflare_artifacts" | "offline_fixture";
	namespace: string;
	name: string;
	remote?: string;
	defaultBranch: "main";
	acceptedRef: "refs/heads/main";
	canonicalRevision: string;
}
export interface MissionAgent {
	developerId: string;
	tool: string;
	instance: string;
	sessionId: string;
}
export interface Mission {
	/** Background supplied by the local agent, without a separate parent record. */
	context?: string;
	id: string;
	version: number;
	title: string;
	specialization: (typeof Specializations)[number];
	plan: z.output<typeof FlightPlanInput>;
	/** Coordination workstream; also the workspace identity. */
	workstreamId?: string;
	/** Accepted revision the mission's workspace started from. */
	baseRevision?: string;
	/** Latest revision published from the mission's workspace. */
	headRevision?: string;
	agent?: MissionAgent;
	/** Isolated experiments of the same mission share a group so approaches can be compared. */
	experimentOf?: string;
	state: "ready" | "active" | "completed";
	at: number;
	completedAt?: number;
}
/** Product view of a mission's isolated Git workspace (one Artifacts fork per workspace). */
export interface Workspace {
	id: string;
	missionId?: string;
	repository: string;
	remote: string;
	baseRevision: string;
	headRevision: string;
	state: string;
}
export interface Artifact {
	id: string;
	kind: (typeof ArtifactKinds)[number];
	missionId: string;
	title: string;
	summary: string;
	/** The Git revision this artifact describes (its anchor). */
	revision: string;
	/** First parent of `revision` for source; equal to `revision` for typed evidence. */
	parentRevision: string;
	contentHash: string;
	storage: { repository: string; path?: string; revision: string };
	producer: { actor: string; kind: Actor["kind"]; sessionId?: string; tool?: string; model?: string };
	execution: { location: (typeof ExecutionLocations)[number]; detail: string };
	related: string[];
	trust: "reported" | "verified";
	/** Source artifacts: commits in base..revision and the number of changed paths. */
	source?: { base: string; commits: { oid: string; message: string }[]; files: number };
	at: number;
}
export interface ProposalDecision {
	outcome: "reject" | "request_changes";
	actor: string;
	reason: string;
	at: number;
}
export interface Proposal {
	id: string;
	number: number;
	version: number;
	missionId: string;
	artifactId: string;
	summary: string;
	impact: string;
	risks: string[];
	questions: string[];
	risk: "low" | "medium" | "high";
	/** Exact Git state: the accepted revision it builds on and the proposed revision. */
	base: string;
	revision: string;
	repository: string;
	commits: number;
	files: number;
	policyVersion: number;
	state: "proposed" | "promoting" | "promoted" | "rejected" | "changes_requested" | "superseded";
	decision?: ProposalDecision;
	supersededBy?: string;
	promotionRequestedAt?: number;
	at: number;
}
export interface VerificationRequest {
	id: string;
	proposalId: string;
	revision: string;
	kinds: VerificationKind[];
	requestedBy: string;
	at: number;
}
export interface Verification {
	id: string;
	proposalId: string;
	revision: string;
	kind: VerificationKind;
	outcome: "pass" | "fail" | "inconclusive";
	artifactIds: string[];
	summary: string;
	actor: string;
	trust: "reported" | "human_attested" | "runtime_verified";
	deploymentId?: string;
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
	repository: string;
	actor: string;
	proposalVersion: number;
	policyVersion: number;
	evidenceIds: string[];
	reviewIds: string[];
	coordinationFingerprint?: string;
	/** Set when the same human decision also deploys the promoted revision to production. */
	deploy?: boolean;
	state: "prepared" | "complete";
	at: number;
	completedAt?: number;
}
export interface PromotionPolicy {
	version: number;
	humanApproval: boolean;
	approvals: number;
	requiredEvidence: VerificationKind[];
	agentPromotion: false;
	resources: ResourcePolicy;
}
/** A resource action awaiting a human, or the record of one that was decided. */
export interface ResourceRequest {
	id: string;
	action: ResourceAction;
	cost: CostClass;
	missionId?: string;
	proposalId?: string;
	environmentId?: string;
	revision?: string;
	requestedBy: string;
	actorKind: Actor["kind"];
	reason: string;
	state: "pending" | "approved" | "denied" | "executed" | "failed";
	decidedBy?: string;
	decision?: string;
	deploymentId?: string;
	at: number;
	decidedAt?: number;
}
export interface SmokeCheck {
	path: string;
	expectStatus: number;
}
export type EnvironmentTarget =
	| {
			type: "cloudflare_worker";
			workerName: string;
			accountId: string;
			/** Artifacts repository Workers Builds is connected to: `main` deploys production, other branches build previews. */
			deployRepository: string;
			deployRemote?: string;
			scriptTag?: string;
	  }
	| { type: "external"; description: string };
export interface Environment {
	id: string;
	name: string;
	kind: "preview" | "production";
	target: EnvironmentTarget;
	smokeChecks: SmokeCheck[];
	createdBy: string;
	at: number;
}
export interface Deployment {
	id: string;
	environmentId: string;
	revision: string;
	proposalId?: string;
	promotionId?: string;
	requestId?: string;
	branch?: string;
	state: "queued" | "building" | "deployed" | "failed" | "superseded";
	buildId?: string;
	url?: string;
	/** Revision that was running in this environment before this deployment. */
	previous?: string;
	rollbackOf?: string;
	evidenceIds: string[];
	actor: string;
	error?: string;
	at: number;
	updatedAt: number;
}
/** Where Cruce consumes infrastructure. Credentials are stored sealed and never returned. */
export interface ResourceAccount {
	mode: "operator" | "connected";
	accountId: string;
	label: string;
	credential: "none" | "stored";
	capabilities: ("artifacts" | "builds")[];
	connectedBy?: string;
	at?: number;
}
export type DeploymentProfile =
	| { kind: "cloudflare_worker"; configPath: string; workerName?: string; revision: string }
	| { kind: "unknown"; revision: string };
export interface PlatformState {
	counter: number;
	version: number;
	missions: Mission[];
	artifacts: Artifact[];
	proposals: Proposal[];
	verificationRequests: VerificationRequest[];
	verifications: Verification[];
	reviews: Review[];
	promotions: Promotion[];
	resourceRequests: ResourceRequest[];
	environments: Environment[];
	deployments: Deployment[];
	usage: Record<string, number>;
	policy: PromotionPolicy;
	replays: Record<string, { request: string; result: unknown }>;
	timeline: { id: string; at: number; actor: string; kind: string; ids: string[]; summary: string }[];
}
export interface PromotionReadiness {
	outcome: "READY" | "NEEDS_ATTENTION" | "VERIFY" | "REFRESH" | "CLOSED";
	reasons: string[];
	evidence: { kind: Verification["kind"]; trust: Verification["trust"]; outcome: Verification["outcome"] }[];
	/** Required kinds still lacking trusted, passing evidence on this exact revision. */
	missing: VerificationKind[];
}
const path = z
	.string()
	.min(1)
	.max(400)
	.refine(
		(p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every((s) => s && s !== "." && s !== ".."),
		"Relative source path required",
	);
const revision = z.string().regex(/^[0-9a-f]{40}$/, "Full 40-character Git revision required");
export const ResourcePolicyInput = z
	.object({
		rules: z.partialRecord(z.enum(RESOURCE_ACTIONS), z.enum(["allow", "approval", "deny"])),
		budgets: z
			.object({
				previewsPerMission: z.number().int().min(0).max(1000),
				previewsPerDay: z.number().int().min(0).max(1000),
				workspacesPerDay: z.number().int().min(0).max(1000),
			})
			.partial(),
	})
	.partial()
	.strict();
export const PlatformCommandInput = z
	.object({
		tool: z.enum(PLATFORM_TOOLS),
		projectId: z.string().min(1).max(300),
		idempotencyKey: z.string().min(1).max(200).optional(),
		expectedVersion: z.number().int().nonnegative().optional(),
		workspace: WorkspaceInput.optional(),
		agent: CommandInput.shape.agent,
		expectedPlanVersion: z.number().int().nonnegative().optional(),
		missionId: z.string().max(100).optional(),
		proposalId: z.string().max(100).optional(),
		artifactId: z.string().max(100).optional(),
		reviewId: z.string().max(100).optional(),
		requestId: z.string().max(100).optional(),
		environmentId: z.string().max(100).optional(),
		deploymentId: z.string().max(100).optional(),
		subjectId: z.string().max(100).optional(),
		sessionId: z.string().max(100).optional(),
		experimentOf: z.string().max(100).optional(),
		title: z.string().max(200).optional(),
		context: z.string().max(4000).optional(),
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
		execution: z.enum(ExecutionLocations).default("local"),
		executionDetail: z.string().max(200).optional(),
		revision: revision.optional(),
		base: revision.optional(),
		path: path.optional(),
		files: z
			.record(path, z.string().max(100000).nullable())
			.refine(
				(files) => Object.keys(files).length <= 250 && new TextEncoder().encode(JSON.stringify(files)).length <= 4 * 1024 * 1024,
				"Bounded source publication exceeded",
			)
			.optional(),
		/** Base64 Git pack (non-thin) containing base..revision, produced by `git pack-objects` locally. */
		pack: z
			.string()
			.max(6 * 1024 * 1024)
			.regex(/^[A-Za-z0-9+/=]+$/, "Base64 Git pack required")
			.optional(),
		message: z.string().max(2000).optional(),
		verificationKind: z.enum(VerificationKinds).optional(),
		verificationKinds: z.array(z.enum(VerificationKinds)).min(1).max(VerificationKinds.length).optional(),
		outcome: z.enum(["pass", "fail", "inconclusive", "approve", "concern", "disagree"]).optional(),
		decision: z.enum(["reject", "request_changes", "approve", "deny"]).optional(),
		deploy: z.boolean().optional(),
		reason: z.string().max(1000).optional(),
		policy: z
			.object({
				approvals: z.number().int().min(1).max(10),
				requiredEvidence: z.array(z.enum(VerificationKinds)).min(1).max(VerificationKinds.length),
				resources: ResourcePolicyInput.optional(),
			})
			.strict()
			.optional(),
		environment: z
			.object({
				kind: z.enum(["cloudflare_worker", "external"]),
				workerName: z
					.string()
					.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Worker names use lowercase letters, digits and dashes")
					.optional(),
				description: z.string().max(400).optional(),
				smokePaths: z
					.array(z.string().regex(/^\/[^\s]{0,200}$/))
					.max(10)
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type PlatformCommand = z.infer<typeof PlatformCommandInput>;
