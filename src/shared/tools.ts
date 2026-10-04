import type { z } from "zod";
import { type CostClass, missingScope, type ResourceAction, type Scope } from "../core/capabilities.ts";
import { CoordinationError } from "../core/workstreams.ts";
import { type Command, CommandInput, TOOLS } from "./coordination.ts";
import { type Actor, HUMAN_TOOLS, type PlatformCommand, PlatformCommandInput, type PlatformTool } from "./platform.ts";

/**
 * Cruce MCP: the intentional machine interface to Cruce's development lifecycle.
 *
 * Every tool expresses a Cruce concept (intent, mission, workspace, revision, evidence, proposal,
 * verification, preview, promotion, lineage). There is deliberately no generic Cloudflare
 * administration here: Cruce decides when Cloudflare capabilities run, behind policy. Use
 * Cloudflare's own MCP servers for account administration.
 */
export interface CruceTool {
	name: string;
	description: string;
	scope: Scope;
	/** control: reads or records Cruce state. resource: may consume infrastructure, governed by policy. */
	class: "control" | "resource";
	cost: CostClass;
	action?: ResourceAction;
	mutation: boolean;
	via: { kind: "platform"; tool: PlatformTool } | { kind: "coordination"; tool: Command["tool"] };
	/** Input fields an agent supplies; identity, idempotency and session fields are added by the adapter. */
	fields: string[];
}
const platform = (tool: PlatformTool) => ({ kind: "platform" as const, tool });
const coordination = (tool: Command["tool"]) => ({ kind: "coordination" as const, tool });
const read = { scope: "cruce:read" as const, class: "control" as const, cost: "none" as const, mutation: false };

export const CRUCE_TOOLS: CruceTool[] = [
	{
		...read,
		name: "get_project",
		description:
			"Project overview: canonical repository in Cloudflare Artifacts, canonical revision, environments, policy and what needs attention.",
		via: platform("get_project"),
		fields: [],
	},
	{
		...read,
		name: "get_context",
		description:
			"Everything an agent needs before working: intent, mission plan, workspace base/head revisions, canonical revision, policy, verification requirements, coordination decision, related artifacts and environments.",
		via: platform("get_context"),
		fields: ["missionId"],
	},
	{
		...read,
		name: "get_mission",
		description: "One mission with its intent, workspace, artifacts, proposals and experiments.",
		via: platform("get_mission"),
		fields: ["missionId"],
	},
	{
		...read,
		name: "get_canonical_revision",
		description: "The accepted revision on the canonical Artifacts repository and recent accepted history.",
		via: platform("get_canonical_revision"),
		fields: [],
	},
	{
		...read,
		name: "get_source",
		description: "List files or read one file at an exact revision (defaults to the canonical revision).",
		via: platform("get_source"),
		fields: ["revision", "path"],
	},
	{
		...read,
		name: "get_diff",
		description: "Changed files and patches between a proposal's base and proposed revisions, or between two revisions.",
		via: platform("get_diff"),
		fields: ["proposalId", "base", "revision", "path"],
	},
	{
		...read,
		name: "get_history",
		description: "Accepted Git history enriched with Cruce lineage (which mission and proposal produced each revision).",
		via: platform("get_history"),
		fields: [],
	},
	{
		...read,
		name: "get_proposal",
		description: "A proposal's exact base/proposed revisions, commits, evidence per revision, readiness, previews and resource impact.",
		via: platform("get_proposal"),
		fields: ["proposalId"],
	},
	{
		...read,
		name: "get_lineage",
		description:
			"Trace lineage. With subjectId (intent, mission, revision, proposal or deployment) returns the connected chain both ways: intent → production and production → intent.",
		via: platform("get_lineage"),
		fields: ["subjectId"],
	},
	{
		...read,
		name: "get_policy",
		description: "Promotion policy, required evidence, resource rules and budgets, and what this connection is allowed to do.",
		via: platform("get_policy"),
		fields: [],
	},
	{
		...read,
		name: "read_artifact",
		description: "Read an immutable artifact (source summary or evidence content) and its provenance.",
		via: platform("read_artifact"),
		fields: ["artifactId"],
	},
	{
		...read,
		name: "get_active_work",
		description: "Active missions' workspaces, plans and coordination decisions.",
		via: coordination("get_active_work"),
		fields: [],
	},
	{
		...read,
		name: "check_coordination",
		description: "Current working/publication/integration decision for your mission's workspace. Also renews your session.",
		via: coordination("check_coordination"),
		fields: [],
	},
	{
		...read,
		name: "get_dependencies",
		description: "Workspaces your mission depends on and their readiness.",
		via: coordination("get_dependencies"),
		fields: [],
	},
	{
		name: "create_intent",
		description: "Record why work should happen (the intent). Missions are bounded work toward an intent.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("create_intent"),
		fields: ["title", "context", "why"],
	},
	{
		name: "create_mission",
		description:
			"Define a bounded mission for an intent with a structured plan (scope, contracts, verification). Set experimentOf to try an alternative approach.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("create_mission"),
		fields: ["intentId", "title", "specialization", "plan", "experimentOf"],
	},
	{
		name: "start_mission",
		description:
			"Start a mission: Cruce pins its base to an accepted revision and creates an isolated workspace (one Artifacts fork). Work locally with your normal tools.",
		scope: "workspace:write",
		class: "resource",
		cost: "artifacts",
		action: "workspace.create",
		mutation: true,
		via: platform("start_mission"),
		fields: ["missionId", "workspace", "agent"],
	},
	{
		name: "update_plan",
		description: "Amend the mission plan after scope changes or a refresh instruction. Coordination is re-evaluated.",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: coordination("update_intent"),
		fields: ["plan", "workspace"],
	},
	{
		name: "report_scope",
		description: "Report actual scope (resources) touched so far.",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: coordination("report_scope"),
		fields: ["plan", "workspace"],
	},
	{
		name: "report_change",
		description: "Report local working-tree changes (cooperative observation; never treated as verified).",
		scope: "workspace:write",
		class: "control",
		cost: "local",
		mutation: true,
		via: coordination("report_change"),
		fields: ["observation"],
	},
	{
		name: "acknowledge_instruction",
		description: "Acknowledge a coordination instruction (refresh, wait, review).",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: coordination("acknowledge_coordination"),
		fields: ["instructionId"],
	},
	{
		name: "respond_to_review",
		description: "Respond to a coordination review instruction.",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: coordination("respond_to_review"),
		fields: ["instructionId", "response", "detail"],
	},
	{
		name: "release_scope",
		description: "Release resources you no longer need, or disconnect your session.",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: coordination("release_scope"),
		fields: ["resources"],
	},
	{
		name: "publish_revision",
		description:
			"Publish your local Git commits (base..revision) to the mission workspace. The local bridge sends a Git pack; Cruce verifies ancestry and scope, then pushes the exact revision with a short-lived server credential.",
		scope: "workspace:write",
		class: "resource",
		cost: "artifacts",
		action: "revision.publish",
		mutation: true,
		via: platform("publish_revision"),
		fields: ["base", "revision", "pack", "files", "message", "title", "summary", "execution", "executionDetail", "model", "related"],
	},
	{
		name: "publish_artifact",
		description: "Store immutable evidence (test report, benchmark, architecture or security analysis…) anchored to an exact revision.",
		scope: "workspace:write",
		class: "resource",
		cost: "artifacts",
		action: "artifact.publish",
		mutation: true,
		via: platform("publish_artifact"),
		fields: ["kind", "revision", "title", "summary", "content", "related", "execution", "executionDetail", "model"],
	},
	{
		name: "create_proposal",
		description: "Propose a published revision for promotion. A proposal always references exact base and proposed revisions.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("create_proposal"),
		fields: ["artifactId", "summary", "impact", "risks", "questions", "risk"],
	},
	{
		name: "attach_evidence",
		description:
			"Attach a verification result for the proposal's exact revision, citing evidence artifacts of that revision. Agent results are recorded as reported.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("attach_evidence"),
		fields: ["proposalId", "verificationKind", "outcome", "related", "summary"],
	},
	{
		name: "request_verification",
		description:
			"Ask for verification kinds (tests, security, architecture…) on the proposal's exact revision. Specialized agents answer with attach_evidence.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("request_verification"),
		fields: ["proposalId", "verificationKinds"],
	},
	{
		name: "review_proposal",
		description: "Record an agent review (approve, concern, disagree) of the exact revision. Agent reviews never replace human approval.",
		scope: "proposal:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("review_proposal"),
		fields: ["proposalId", "outcome", "summary"],
	},
	{
		name: "request_preview",
		description:
			"Request a Worker preview of the proposal's exact revision. Cruce checks the revision, Worker compatibility, policy, budgets and the connected account; the result is a preview deployment, a pending human approval, or a refusal.",
		scope: "preview:request",
		class: "resource",
		cost: "metered",
		action: "preview.deploy",
		mutation: true,
		via: platform("request_preview"),
		fields: ["proposalId"],
	},
	{
		name: "request_promotion",
		description: "Ask humans to promote a proposal. Returns readiness; agents can never promote accepted source or deploy production.",
		scope: "promotion:request",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("request_promotion"),
		fields: ["proposalId"],
	},
	{
		name: "complete_mission",
		description: "Mark the mission's work complete. Completion never promotes accepted state.",
		scope: "workspace:write",
		class: "control",
		cost: "none",
		mutation: true,
		via: platform("complete_mission"),
		fields: ["missionId", "summary"],
	},
];
export const CRUCE_TOOL_NAMES = CRUCE_TOOLS.map((t) => t.name);
export const toolByName = (name: string) => CRUCE_TOOLS.find((t) => t.name === name);

/** Agent-facing input schema for a tool: its own fields, all optional where the adapter fills context. */
export function toolInputShape(tool: CruceTool): Record<string, z.ZodType> {
	const source = (tool.via.kind === "platform" ? PlatformCommandInput.shape : CommandInput.shape) as Record<string, z.ZodType>;
	const shape: Record<string, z.ZodType> = {};
	for (const field of tool.fields) if (source[field]) shape[field] = source[field].optional();
	// Context the bridge normally supplies; remote clients pass it explicitly.
	for (const field of ["missionId", "proposalId", "expectedVersion", "expectedPlanVersion", "sessionId", "workstreamId", "idempotencyKey"])
		if (source[field] && !shape[field] && (tool.mutation || field === "missionId" || field === "workstreamId" || field === "sessionId"))
			shape[field] = source[field].optional();
	shape.projectId = source.projectId;
	return shape;
}

/** Translate a public tool call into the internal command. */
export function toInternalCommand(tool: CruceTool, args: Record<string, unknown>): Command | PlatformCommand {
	return tool.via.kind === "platform"
		? PlatformCommandInput.parse({ ...args, tool: tool.via.tool })
		: CommandInput.parse({ ...args, tool: tool.via.tool });
}

export const CRUCE_INSTRUCTIONS =
	"Cruce coordinates your work; it does not run you. Read get_context before working. start_mission pins an accepted base revision and an isolated workspace. Work locally with your normal tools and Git, then publish_revision (exact commits), publish_artifact for evidence anchored to that revision, and create_proposal. Verification always targets an exact revision; your own results are recorded as reported evidence. Preview requests are metered and governed by policy; production promotion is always a human decision. Check coordination before expanding scope; acknowledge instructions and refresh to the revision Cruce names, preserving working-tree changes.";

/** Scope an agent needs for an internal command (HTTP and MCP share one authority). Undefined: humans only. */
export function requiredScope(kind: "platform" | "coordination", tool: string): Scope | undefined {
	const listed = CRUCE_TOOLS.find((t) => t.via.kind === kind && t.via.tool === tool);
	if (listed) return listed.scope;
	if (kind === "coordination") return tool === "get_project_context" ? "cruce:read" : "workspace:write";
	return undefined;
}

/** Agent connections carry explicit scopes; human decisions are never reachable through them. */
export function authorizeMachine(actor: Actor, cmd: { tool: string }) {
	if (actor.kind !== "agent") return;
	const kind = (TOOLS as readonly string[]).includes(cmd.tool) ? "coordination" : "platform";
	if (kind === "platform" && HUMAN_TOOLS.has(cmd.tool))
		throw new CoordinationError(403, `${cmd.tool} is a human decision; agents can request it but never perform it`);
	const scope = requiredScope(kind, cmd.tool);
	if (!scope) throw new CoordinationError(403, `${cmd.tool} is not available to agents`);
	const missing = missingScope(actor.scopes, scope);
	if (missing) throw new CoordinationError(403, missing);
}
