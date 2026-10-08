import type { Scope } from "../core/capabilities.ts";
import { DomainError } from "../core/errors.ts";
import { type Authority, type Command, CommandInput, type CostClass, type ResourceAction } from "./platform.ts";
export const CRUCE_INSTRUCTIONS =
	"Use the Cruce tools at task start in a Cruce checkout: start_workspace, or continue the workspace already attached to this directory. Use them again when scope changes (list_active_workspaces, inspect_overlap, get_workspace_updates) and to publish pushed revisions (publish_revision), evidence and proposals. If a tool reports this directory is not a Cruce checkout, work without Cruce and tell the user how to clone it from Cruce. Cruce is the durable Git coordination plane for this repository: Namespace → Repository → Workspace. A workspace is a durable stream of Git work owned by a user, not by this session; it has an immutable baseline and its own fork, and may be continued later from another session, tool or machine. Start a workspace at an exact Git revision and work only in the dedicated directory the bridge returns. For parallel work, keep each workspace attached in its own directory and pass workspaceId on workspace tools; one bridge can coordinate several workspaces. To continue existing work, call attach_workspace with its workspaceId through the bridge; it returns the local directory without requiring a CLI handoff or MCP restart. Omitted workspaceId uses the bridge's current workspace. Use normal Git to commit and push to the workspace fork; publish_revision retains an exact pushed revision but does not request review: when your task's work is done, propose that revision with create_proposal (unless the user asked you to hold it) so a human can review it. Inspect list_active_workspaces, inspect_overlap and get_workspace_updates at the start and when scope changes: overlap is advisory, not a conflict verdict, and inspect updates again before proposing or requesting promotion. When canonical moves, merge it into your attached workspace just before you publish and propose, or earlier when the user asks: preserve working changes, fetch canonical, merge with Git, verify, push, publish and propose the new exact revision with fresh evidence. Updating right before proposing lets the human review once, on the revision that would land. Use preview_reconciliation through the local bridge for an explicit exact-commit Git merge check; missing source requires a normal Git fetch, and a clean preview still needs verification. Reported shared paths are advisory, including stale or unknown reports. An external host can consume changed repository state from cruce watch --coordination; the host owns agent continuation. The local bridge appends current coordination state to tool responses and exposes a subscribable repository_coordination resource. When a response or prompt hint starts with \"Cruce:\" and names workspaces behind canonical, a human promoted other work: merge canonical into the named workspaces attached here before publishing or proposing them. Update a workspace that is not attached here only when the user asks you to continue it. Inspect the resource when notified. If work remains when you stop, identify the exact workspace and revision for continuation. Reconciliation does not require human intervention by itself. Ask the user when unresolved conflicts, ambiguous intent or failing checks require their judgment; never infer conflicts from divergence or correctness from a clean merge. Propose exact revisions and record evidence for them; reported evidence is not verification. Reviewers leave notes on changes: when a response or prompt hint says notes await the owner, or the user asks you to address review notes, read get_review_notes, change the code with Git where you agree, verify, push, publish and propose the new revision, then reply_review_note on each note citing it, or reply with your reasoning where you disagree. Never treat a reply as resolution; a human resolves notes. Canonical promotion is a human decision. Cruce does not run, schedule or message agents, and its responsibility ends at canonical Git; CI, release, deployment and runtime management are external. Never discard working changes to refresh a workspace.";
/**
 * Fixed prompts a user can run from their own agent tool. They are instruction text shipped with Cruce, never stored or
 * sent by Cruce: the user chooses when to run one.
 */
export const CRUCE_PROMPTS = [
	{
		name: "address_review_notes",
		title: "Address Cruce review notes",
		description: "Read the review notes waiting on your open Cruce change, address them, publish the fix and reply on each note.",
		text: "Address the review notes on my Cruce change. Call get_review_notes for the workspace attached here; if none is attached, ask me which workspace. For each note that awaits the owner: if you agree, change the code in that workspace's directory with Git and verify it, then push, publish_revision and create_proposal for the new exact revision, and reply_review_note on the note with citedRevision set to that revision. If you disagree or need my judgment, reply_review_note with your reasoning instead and tell me. A reply never resolves a note; a human resolves notes in the Cruce console. Finish by summarizing what you changed, the new revision, and what still needs me.",
	},
] as const;
export interface Tool {
	/** Local computation in the bridge; never dispatched to hosted controllers. */
	bridgeOnly?: boolean;
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
	{
		...write(
			"preview_reconciliation",
			"Explicit local Git merge preview of committed workspace HEAD against accepted canonical. Uses disposable local objects; no provider cost, fetch, checkout/index/ref change, verification or approval. Missing local source is unavailable; fetch with ordinary Git before retrying. Local bridge only.",
			["workspaceId"],
			"cruce:read",
		),
		bridgeOnly: true,
	},
	read("list_namespaces", "List your authorized namespaces."),
	read("list_repositories", "List repositories authorized for this connection.", ["namespaceId"]),
	read("get_activity", "Read retained activity in bounded pages; pass the returned cursor for the next page.", ["cursor"]),
	read(
		"get_archive",
		"Finished work, newest first in bounded pages: ended workspaces whose forks are gone, with their closed changes, publications, evidence and promotions. Pass subjectId for the archived record containing it.",
		["cursor", "subjectId"],
	),
	read("get_retention", "Inspect recorded retention blockers and authorized cleanup recovery without provider calls.", ["workspaceId"]),
	read(
		"get_reconciliation",
		"Read repository reconciliation, exact published ancestry, proposal blockers and observation health. Never fetches or writes.",
	),
	read(
		"get_repository",
		"Repository state, current workspaces, changes, artifacts, observation freshness and a read-only attention projection: each item's owner, exact revision, structured blockers and the caller's eligible actions. Attention assigns nothing.",
	),
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
	read(
		"get_source",
		"Read bounded retained source from the local cache. For explicit cloud inspection use inspect_source; for cache loss use recover_source.",
		["revision", "path"],
	),
	read("get_history", "Read up to 30 cached Git commits. For explicitly labelled stored first-parent history use inspect_source.", [
		"revision",
	]),
	read(
		"get_diff",
		"Bounded exact Git diff between retained revisions in the local cache. inspect_source can explicitly recover missing objects.",
		["baseRevision", "revision", "path"],
	),
	read(
		"read_artifact",
		"Read immutable artifact metadata and locally cached content. inspect_source explicitly reads stored evidence after cache loss.",
		["artifactId"],
	),
	read("get_lineage", "Trace workspace, actor, commit, artifact, review and source promotion provenance.", ["subjectId"]),
	read(
		"get_review_notes",
		"Review notes on a workspace's open change, including notes inherited from the changes it superseded: each note's kind (concern or comment), its anchor (exact revision, path, line and that line's text), replies, and whether it awaits the owner, awaits the reviewer or is resolved. Pass workspaceId or proposalId.",
		["workspaceId", "proposalId"],
	),
	write(
		"inspect_source",
		"Explicit cloud source inspection: bounded file listing/content, first-parent history, diff, or stored evidence. Uses one namespace resource reservation. Files/history use provider APIs; diffs may recover bounded Git objects. Never approves source.",
		["sourceView", "revision", "baseRevision", "path", "artifactId"],
		"cruce:read",
		"source.read",
	),
	write(
		"recover_source",
		"Explicitly recover retained source into the bounded Git cache for ancestry, diffs and pack operations. Uses one namespace resource reservation; exact storage identity and refs are checked.",
		["revision"],
		"cruce:read",
		"source.read",
	),
	write(
		"start_workspace",
		"Start a durable workspace at an exact baseline revision; the local bridge returns an isolated directory and keeps previously started workspaces attached.",
		["title", "baseRevision", "branch", "description"],
	),
	write(
		"attach_workspace",
		"Attach this exclusive local execution to your workspace, provisioning its Cloudflare Artifacts fork of canonical once. Fails while another execution is attached. Through the local bridge, pass workspaceId to create or reuse its local worktree and return the directory; other workspaces stay attached.",
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
		"inspect_retention",
		"Explicitly check every fork ref against retained source and record bounded blockers. This consumes a source-read reservation and never deletes a fork.",
		["workspaceId"],
		"cruce:read",
		"source.read",
	),
	write(
		"cleanup_workspace",
		"Authorize deletion of an ended workspace fork after every remote ref is retained. The journal resumes this exact operation after interruption under current authority. Local files are unaffected.",
		["workspaceId"],
		"workspace:write",
		"workspace.cleanup",
	),
	write(
		"end_workspace",
		"End the workspace and release its checkout, keeping local files, commits and artifacts. cancelled: true abandons the work and withdraws its open changes.",
		["workspaceId", "cancelled"],
	),
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
	write(
		"create_proposal",
		"Propose an exact source artifact for review. If its workspace is behind canonical, merge canonical and publish first: a change on a stale base cannot be promoted.",
		["workspaceId", "artifactId", "title"],
		"change:write",
	),
	write(
		"review_proposal",
		"Review an exact revision with a reason.",
		["workspaceId", "proposalId", "revision", "outcome", "reason"],
		"change:write",
	),
	write(
		"record_verification",
		"Record reported evidence for an exact revision.",
		["workspaceId", "proposalId", "revision", "kind", "outcome", "reason", "artifactId"],
		"change:write",
	),
	write(
		"add_review_note",
		"Add a concern or comment to an open change's exact revision, optionally anchored to one line with path, line, anchorRevision (the change's revision, its review base or an earlier revision of the same change) and lineText. A concern blocks promotion until a human maintainer resolves it.",
		["workspaceId", "proposalId", "revision", "kind", "body", "path", "line", "anchorRevision", "lineText"],
		"change:write",
	),
	write(
		"reply_review_note",
		"Reply to a review note, optionally with citedRevision: the published revision of this workspace that addresses it. Replying never resolves a note; a human maintainer does.",
		["workspaceId", "noteId", "body", "citedRevision"],
		"change:write",
	),
	write("request_promotion", "Request human review and source promotion.", ["workspaceId", "proposalId"], "promotion:request"),
];
export const HUMAN_TOOLS = new Set([
	"archive_repository",
	"restore_repository",
	"delete_repository",
	"release_resource_operation",
	"resolve_review",
	"resolve_review_note",
	"reject_proposal",
	"promote_proposal",
	"retry_repository_setup",
	"configure_observation",
]);
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
	if (!tool || tool.bridgeOnly || !a.scopes?.includes(tool.scope)) throw new DomainError(403, "Agent capability denied");
	if (cmd.humanAttested) throw new DomainError(403, "Agents cannot attest human verification");
}
