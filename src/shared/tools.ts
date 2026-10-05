import type { Scope } from "../core/capabilities.ts";
import { DomainError } from "../core/errors.ts";
import { type Authority, type Command, CommandInput, type CostClass, type ResourceAction } from "./platform.ts";
export const CRUCE_INSTRUCTIONS =
	"Cruce is the durable Git coordination plane for this repository: Namespace → Repository → Workspace. A workspace is a durable stream of Git work owned by a user, not by this session; it has an immutable baseline and its own fork, and may be continued later from another session, tool or machine. Start a workspace at an exact Git revision and work only in the dedicated directory the bridge returns. Use normal Git to commit and push to the workspace fork; publish_revision retains an exact pushed revision for review. Inspect list_active_workspaces, inspect_overlap and get_workspace_updates at the start and when scope changes: overlap is advisory, not a conflict verdict, and canonical movement means you must fetch, merge, verify and publish a reconciled revision. Propose exact revisions and record evidence for them; reported evidence is not verification. Canonical promotion is a human decision. Cruce does not run, schedule or message agents, and its responsibility ends at canonical Git; CI, release, deployment and runtime management are external. Never discard working changes to refresh a workspace.";
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
	cost: action ? "artifacts" : "none",
	action,
});
export const CRUCE_TOOLS: Tool[] = [
	read("list_namespaces", "List your authorized namespaces."),
	read("list_repositories", "List repositories authorized for this connection.", ["namespaceId"]),
	read("get_repository", "Repository state, current workspaces, changes, artifacts and observation freshness."),
	read("get_workspace", "Inspect a workspace: owner, baseline, fork, current execution attachment and revisions.", ["workspaceId"]),
	read(
		"get_workspace_updates",
		"Inspect upstream changes and advisory path overlap since the workspace's last integrated revision. Reads never fetch or provision.",
		["workspaceId"],
	),
	read("list_active_workspaces", "Unended workspaces, including disconnected and detached ones."),
	read("inspect_overlap", "Advisory overlap based on current reported paths."),
	read("get_git_access", "Inspect canonical and workspace Git remote paths. Authenticate Git with your Cruce OAuth connection.", [
		"workspaceId",
	]),
	read("get_source", "Read an uploaded immutable source revision. Unavailable until source is explicitly published.", ["revision", "path"]),
	read("get_history", "Git commit history for an uploaded revision.", ["revision"]),
	read("get_diff", "Exact Git diff between uploaded revisions.", ["baseRevision", "revision", "path"]),
	read("read_artifact", "Read immutable artifact metadata and stored content.", ["artifactId"]),
	read("get_lineage", "Trace workspace, actor, commit, artifact, review and source promotion provenance.", ["subjectId"]),
	write("start_workspace", "Start a durable workspace at an exact baseline revision; use the local bridge for an isolated checkout.", [
		"title",
		"baseRevision",
		"branch",
		"description",
	]),
	write(
		"attach_workspace",
		"Attach this exclusive local execution to your workspace, provisioning its Cloudflare Artifacts fork of canonical once. Fails while another execution is attached.",
		["workspaceId", "execution"],
		"workspace:write",
		"workspace.fork",
	),
	write(
		"detach_workspace",
		"Release the current execution attachment so the workspace can continue elsewhere. Keeps the fork, revisions and provenance.",
		["workspaceId"],
	),
	write("heartbeat", "Renew presence of the attached execution.", ["workspaceId", "execution"]),
	write("report_change", "Report changed paths and commits in the attached execution; cooperative observation, not verification.", [
		"workspaceId",
		"execution",
		"revision",
		"branch",
		"changes",
		"commits",
	]),
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
	write("request_promotion", "Request human review and source promotion.", ["proposalId"], "promotion:request"),
];
export const HUMAN_TOOLS = new Set(["resolve_review", "reject_proposal", "promote_proposal"]);
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
