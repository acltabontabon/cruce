import type { Scope } from "../core/capabilities.ts";
import { DomainError } from "../core/errors.ts";
import { type Authority, type Command, CommandInput, type CostClass, type ResourceAction } from "./platform.ts";
export const CRUCE_INSTRUCTIONS =
	"Cruce coordinates developers and agents through Namespace → Repository → Workspace. Start a workspace at an exact Git revision. Writers attach an exclusive execution context; agent writers work in the dedicated directory returned by the bridge. Hosted writers use normal Git to push into their own workspace fork; publish_revision seals an exact pushed revision for review. Report changes and inspect advisory overlap and get_workspace_updates. Use get_git_access for canonical and fork remotes. Fetch and merge with normal Git when ready, verify, then publish exact revisions and artifacts. Keep the original starting revision and previous published commits reachable. Local reports are not runtime verification. Source promotion and production deployment require a human decision. Never discard working changes to refresh a workspace.";
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
	scope: Scope = "workspace:write",
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
	read("list_namespaces", "List your authorized namespaces."),
	read("list_repositories", "List repositories authorized for this connection.", ["namespaceId"]),
	read("get_repository", "Repository state, current workspaces, changes, artifacts, deployments and observation freshness."),
	read("get_context", "Instructions at a workspace's immutable base revision, with namespace and repository policies.", ["workspaceId"]),
	read("get_workspace", "Inspect a workspace and its execution context.", ["workspaceId"]),
	read(
		"get_workspace_updates",
		"Inspect upstream changes and advisory path overlap since the workspace's last integrated revision. Reads never fetch or provision.",
		["workspaceId"],
	),
	read("list_active_workspaces", "Active and disconnected workspaces."),
	read("inspect_overlap", "Advisory overlap based on current reported paths."),
	read("get_git_access", "Inspect canonical and workspace Git remote paths. Authenticate Git with your Cruce OAuth connection.", [
		"workspaceId",
	]),
	read("get_source", "Read an uploaded immutable source revision. Unavailable until source is explicitly published.", ["revision", "path"]),
	read("get_history", "Git commit history for an uploaded revision.", ["revision"]),
	read("get_diff", "Exact Git diff between uploaded revisions.", ["baseRevision", "revision", "path"]),
	read("read_artifact", "Read immutable artifact metadata and stored content.", ["artifactId"]),
	read("get_lineage", "Trace workspace, actor, commit, artifact, review and deployment provenance.", ["subjectId"]),
	write("start_workspace", "Register bounded work from an exact Git revision; use the local bridge for isolated execution.", [
		"title",
		"baseRevision",
		"branch",
		"mode",
		"context",
	]),
	write(
		"attach_workspace",
		"Attach an exclusive local execution context and provision its canonical Artifacts fork once.",
		["workspaceId", "execution"],
		"workspace:write",
		"workspace.fork",
	),
	write("heartbeat", "Renew workspace presence without changing its starting revision.", ["workspaceId"]),
	write("report_change", "Report local changed paths and commits; this is cooperative observation, not runtime verification.", [
		"workspaceId",
		"revision",
		"branch",
		"changes",
		"commits",
	]),
	write("report_ref", "Report a locally observed ref without claiming remote push verification.", ["workspaceId", "ref", "revision"]),
	write(
		"cleanup_workspace",
		"Delete an ended workspace fork only after every remote ref is retained. Local files are unaffected.",
		["workspaceId"],
		"workspace:write",
		"workspace.cleanup",
	),
	write("end_workspace", "End participation, preserving working changes, commits and artifacts.", ["workspaceId", "cancelled"]),
	write(
		"publish_revision",
		"Seal an exact pushed fork revision as an immutable source artifact. Push with normal Git first.",
		["workspaceId", "revision", "baseRevision", "ref", "title"],
		"revision:publish",
		"revision.publish",
	),
	write(
		"publish_artifact",
		"Store immutable evidence for an exact workspace revision.",
		["workspaceId", "revision", "content", "title"],
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
		"namespaceId",
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
