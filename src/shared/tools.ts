import type { Scope } from "../core/capabilities.ts";
import { DomainError } from "../core/errors.ts";
import { type Authority, type Command, CommandInput, type CostClass, type ResourceAction } from "./platform.ts";
export const CRUCE_INSTRUCTIONS =
	"Cruce coordinates developers and agents through Workspace → Repository → Session. Start a session at an exact Git revision. Writers attach an exclusive execution context; agent writers work in the dedicated directory returned by the bridge. Report changes, inspect advisory overlap, commit with normal Git, then publish exact revisions and artifacts. Local reports are not runtime verification. Source promotion and production deployment require a human decision. Never discard working changes to refresh a session.";
export interface Tool {
	name: string;
	description: string;
	scope: Scope;
	mutation: boolean;
	class: "control" | "resource";
	cost: CostClass;
	action?: ResourceAction;
	fields: (keyof Command)[];
}
const read = (name: string, description: string, fields: (keyof Command)[] = []): Tool => ({
	name,
	description,
	fields,
	scope: "cruce:read",
	mutation: false,
	class: "control",
	cost: "none",
});
const write = (
	name: string,
	description: string,
	fields: (keyof Command)[],
	scope: Scope = "session:write",
	action?: ResourceAction,
): Tool => ({
	name,
	description,
	fields,
	scope,
	mutation: true,
	class: action ? "resource" : "control",
	cost: action ? (action === "preview.deploy" ? "metered" : "artifacts") : "none",
	action,
});
export const CRUCE_TOOLS: Tool[] = [
	read("list_workspaces", "List your authorized workspaces."),
	read("list_repositories", "List repositories authorized for this connection.", ["workspaceId"]),
	read("get_repository", "Repository state, current sessions, changes, artifacts, deployments and observation freshness."),
	read("get_context", "Instructions at a session's immutable base revision, with workspace and repository policies.", ["sessionId"]),
	read("get_session", "Inspect a session and its execution context.", ["sessionId"]),
	read("list_active_sessions", "Active and disconnected sessions."),
	read("inspect_overlap", "Advisory overlap based on current reported paths."),
	read("export_revision", "Export a published source revision as exact Git objects for checkout or refresh.", ["revision"]),
	read("get_source", "Read an uploaded immutable source revision. Unavailable until source is explicitly published.", ["revision", "path"]),
	read("get_history", "Git commit history for an uploaded revision.", ["revision"]),
	read("get_diff", "Exact Git diff between uploaded revisions.", ["baseRevision", "revision", "path"]),
	read("read_artifact", "Read immutable artifact metadata and stored content.", ["artifactId"]),
	read("get_lineage", "Trace session, actor, commit, artifact, review and deployment provenance.", ["subjectId"]),
	write("start_session", "Register bounded work from an exact Git revision; use the local bridge for isolated execution.", [
		"title",
		"baseRevision",
		"branch",
		"mode",
		"context",
	]),
	write(
		"attach_session",
		"Reserve an exclusive execution context. Local attachment is free; hosted writers consume an Artifacts fork.",
		["sessionId", "execution"],
		"session:write",
		"session.fork",
	),
	write("heartbeat", "Renew session presence without changing its starting revision.", ["sessionId"]),
	write("report_change", "Report local changed paths and commits; this is cooperative observation, not runtime verification.", [
		"sessionId",
		"revision",
		"branch",
		"changes",
		"commits",
	]),
	write("report_ref", "Report a locally observed ref without claiming remote push verification.", ["sessionId", "ref", "revision"]),
	write("end_session", "End participation, preserving working changes, commits and artifacts.", ["sessionId", "cancelled"]),
	write(
		"publish_revision",
		"Publish exact committed Git objects as an immutable source artifact.",
		["sessionId", "revision", "pack", "title"],
		"revision:publish",
		"revision.publish",
	),
	write(
		"publish_artifact",
		"Store immutable evidence for an exact session revision.",
		["sessionId", "revision", "content", "title"],
		"artifact:publish",
		"artifact.publish",
	),
	write("create_proposal", "Propose an exact source artifact for review.", ["artifactId", "title"], "change:write"),
	write("review_proposal", "Review an exact revision with a reason.", ["proposalId", "revision", "outcome", "reason"], "change:write"),
	write(
		"record_verification",
		"Record reported evidence for an exact revision.",
		["proposalId", "revision", "kind", "outcome", "reason", "artifactId"],
		"change:write",
	),
	write(
		"request_preview",
		"Build and deploy an immutable source artifact to a configured preview environment.",
		["artifactId", "environmentId"],
		"preview:request",
		"preview.deploy",
	),
	write("request_promotion", "Request human review and source promotion.", ["proposalId"], "promotion:request"),
];
export const HUMAN_TOOLS = new Set(["resolve_review", "reject_proposal", "promote_proposal", "configure_environment", "deploy_artifact"]);
export function toolByName(name: string) {
	return CRUCE_TOOLS.find((t) => t.name === name);
}
export function toolInputShape(tool: Tool) {
	const fields = new Set<keyof Command>([
		"workspaceId",
		"repositoryId",
		...tool.fields,
		...(tool.mutation ? ["idempotencyKey" as const] : []),
	]);
	return Object.fromEntries([...fields].map((field) => [field, CommandInput.shape[field]]));
}
export function toInternalCommand(tool: Tool, args: Record<string, unknown>): Command {
	return CommandInput.parse({ ...args, tool: tool.name });
}
export function authorizeMachine(a: Authority, cmd: Command) {
	if (a.actor.kind !== "agent") return;
	const tool = toolByName(cmd.tool);
	if (!tool || !a.scopes?.includes(tool.scope)) throw new DomainError(403, "Agent capability denied");
	if (cmd.humanAttested) throw new DomainError(403, "Agents cannot attest human verification");
}
