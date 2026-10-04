import { z } from "zod";
import type { AirspaceIndex } from "../core/airspace.ts";
import { type FlightPlanFields, FlightPlanInput } from "../core/domain.ts";
import type { ChangedFile } from "../core/publish-gate.ts";

export const TOOLS = [
	"register_intent",
	"update_intent",
	"attach_workstream",
	"get_system_context",
	"get_active_work",
	"get_dependencies",
	"check_coordination",
	"report_scope",
	"report_change",
	"request_publish",
	"acknowledge_coordination",
	"respond_to_review",
	"release_scope",
	"complete_workstream",
] as const;
export type Tool = (typeof TOOLS)[number];
export type Outcome = "PROCEED" | "PROCEED_WITH_CONSTRAINTS" | "WAIT" | "REPLAN" | "BLOCK";
export type Capability = "git_observation" | "intent_mcp" | "adaptive" | "native_guard" | "managed_artifacts" | "native_promotion";
export interface Principal {
	developerId: string;
	tenantId: string;
	systemIds: string[];
	maintainer?: boolean;
	canWrite?: boolean;
}
export interface SystemConnection {
	id: string;
	tenantId: string;
	artifactRepository: string;
	name: string;
	active: boolean;
	version: number;
	canonicalHead?: string;
	capabilities: Capability[];
	policy: {
		mode: "observation" | "enforced";
		semantic: "off" | "shadow" | "advisory" | "automatic";
	};
}
export function systemKey(tenant: string, immutableId: string) {
	return JSON.stringify([tenant, immutableId]);
}
export interface WorkspaceAttachment {
	id: string;
	checkoutId: string;
	branch: string;
	base: string;
	head: string;
	isolation: "isolated" | "shared";
	precision: "files" | "symbols";
	capabilities: Capability[];
}
export interface AgentSession {
	id: string;
	developerId: string;
	tool: string;
	instance: string;
	role: "writer" | "observer";
	workstreamId: string;
	workspace: WorkspaceAttachment;
	expiresAt: number;
	connected: boolean;
}
export interface Plan extends FlightPlanFields {
	version: number;
	baseline: string;
	at: number;
}
export interface Publication {
	planVersion?: number;
	head: string;
	base: string;
	verified: boolean;
	integrated: boolean;
	observationId: string;
	resources: string[];
}
export interface Instruction {
	id: string;
	kind: "continue" | "wait" | "refresh" | "review" | "amend" | "yield";
	fingerprint: string;
	resources: string[];
	requiredRevision?: string;
	receivedAt?: number;
	responses: { at: number; outcome: "amended" | "cannot_progress" | "reviewed"; detail: string }[];
	resolvedAt?: number;
}
export interface Workstream {
	id: string;
	legacyFlightId?: string;
	owner: string;
	version: number;
	title: string;
	state: "active" | "completed" | "integrated";
	plans: Plan[];
	sessions: string[];
	publications: Publication[];
	instructions: Instruction[];
	staleRevision?: string;
	released: string[];
	createdAt: number;
}
export interface ManagedWorkspaceRecord {
	workstreamId: string;
	backend: "cloudflare_artifacts";
	repository: string;
	remote: string;
	baseline: string;
	head: string;
	state: "requested" | "provisioning" | "active" | "validating" | "publish_ready" | "published" | "archived" | "expired";
	createdAt: number;
	expiresAt?: number;
	archivedAt?: number;
	owned: boolean;
	error?: string;
}
export interface Observation {
	kind?: "working_tree" | "commit";
	id: string;
	workstreamIds: string[];
	base: string;
	head: string;
	branch: string;
	source: "assertion" | "local_git" | "provider" | "managed_git";
	verified: boolean;
	at: number;
	changes: ChangedFile[];
	index: AirspaceIndex;
	headIndex: AirspaceIndex;
	limitations: string[];
}
export interface SemanticConstraint {
	id: string;
	capability: string;
	workstreamId: string;
	dependency?: string;
	resources: string[];
	evidence: string[];
	probability: number;
	response: "publication_dependency" | "review" | "escalate";
	fingerprint: string;
	model: string;
	automatic: boolean;
}
export interface ScopedOverride {
	id: string;
	workstreamId: string;
	actor: string;
	reason: string;
	resources: string[];
	fingerprint: string;
	at: number;
	expiresAt: number;
}
export interface Decision {
	displayStatus: "Working safely" | "Coordinated" | "Waiting" | "Needs attention" | "Ready";
	workstreamId: string;
	workstreamVersion: number;
	planVersion: number;
	working: Outcome;
	publication: Outcome;
	integration: Outcome;
	cleared: string[];
	constrained: { resource: string; reason: string; boundary: "working" | "publication" | "integration" }[];
	dependencies: {
		workstreamId: string;
		revision?: string;
		readiness: "unpublished" | "published_candidate" | "promoted_canonical";
		reason: string;
	}[];
	reasons: { rule: string; evidence: string[]; detail: string }[];
	nextAction: string;
	revision: number;
	fingerprint: string;
	validity: { systemVersion: number; canonicalHead?: string; planVersions: Record<string, number>; expiresAt: number };
	coverage: { capabilities: Capability[]; limitations: string[]; intent: boolean };
	instructions: Instruction[];
	overridden: boolean;
	human: string;
}
export interface CoordinationState {
	system: SystemConnection;
	revision: number;
	counter: number;
	index: AirspaceIndex;
	workstreams: Workstream[];
	sessions: AgentSession[];
	observations: Observation[];
	semantic: SemanticConstraint[];
	overrides: ScopedOverride[];
	replays: Record<string, { request: string; result: unknown }>;
	audit: { at: number; actor: string; command: string; workstreamId?: string; detail: string }[];
}

const path = z
	.string()
	.min(1)
	.max(400)
	.refine(
		(p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every((s) => s && s !== "." && s !== ".."),
		"Relative source path required",
	);
export const WorkspaceInput = z.object({
	id: z.string().min(1).max(200),
	checkoutId: z.string().min(1).max(200),
	branch: z.string().max(250),
	base: z.string().min(1).max(64),
	head: z.string().min(1).max(64),
	isolation: z.enum(["isolated", "shared"]),
	precision: z.enum(["files", "symbols"]),
	capabilities: z.array(z.enum(["git_observation", "intent_mcp", "adaptive", "native_guard", "managed_artifacts", "native_promotion"])),
});
export const CommandInput = z.object({
	tool: z.enum(TOOLS),
	systemId: z.string().min(1).max(300),
	idempotencyKey: z.string().min(1).max(200).optional(),
	workstreamId: z.string().max(80).optional(),
	sessionId: z.string().max(80).optional(),
	expectedVersion: z.number().int().nonnegative().optional(),
	expectedPlanVersion: z.number().int().nonnegative().optional(),
	plan: FlightPlanInput.optional(),
	workspace: WorkspaceInput.optional(),
	agent: z
		.object({
			tool: z.string().min(1).max(80),
			instance: z.string().min(1).max(200),
			role: z.enum(["writer", "observer"]).default("writer"),
		})
		.optional(),
	instructionId: z.string().max(80).optional(),
	response: z.enum(["amended", "cannot_progress", "reviewed"]).optional(),
	detail: z.string().max(1000).optional(),
	resources: z.array(z.string().max(400)).max(100).optional(),
	observation: z
		.object({
			kind: z.enum(["working_tree", "commit"]).optional(),
			base: z.string().min(1).max(64),
			head: z.string().min(1).max(64),
			branch: z.string().max(250),
			files: z.record(path, z.string().max(100000)).optional(),
			headFiles: z.record(path, z.string().max(100000)).optional(),
			changes: z
				.array(
					z.object({
						path,
						status: z.enum(["added", "modified", "deleted"]),
						ranges: z
							.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive(), insert: z.boolean().optional() }))
							.max(1000),
					}),
				)
				.max(500),
		})
		.optional(),
});
export type Command = z.infer<typeof CommandInput>;
export const READ_TOOLS = new Set<Tool>(["get_system_context", "get_active_work", "get_dependencies", "check_coordination"]);
export const PARTICIPATION =
	"Register your task and structured plan before shared changes. Check coordination before expanding scope, publication, and after context changes. Continue cleared scope, preserve working-tree changes, acknowledge instructions, refresh the specified revision using your normal tools, then amend your plan. Cruce does not authorize reset or discarded code. Source and evidence are durable Artifacts. Agents create proposals; human review and policy govern promotion. Local checks are cooperative; managed publication is verified by Cruce.";
