import type { McpServer } from "@modelcontextprotocol/server";
import { reportFreshness } from "../src/core/reconciliation.ts";
import type { RepositorySnapshot } from "../src/shared/platform.ts";

/** Current controller state, not an assignment, acknowledgement or agent conversation. */
export function coordinationContext(
	snapshot: Pick<RepositorySnapshot, "attention" | "sourceHead"> &
		Partial<Pick<RepositorySnapshot, "workspaces" | "overlaps" | "asOf" | "workspaceUpdates" | "reconciliation">>,
) {
	if (!snapshot.attention) return { available: false as const, instruction: "Read get_repository to inspect current coordination state." };
	const workspaces = snapshot.workspaces ?? [];
	const owned = new Set(workspaces.filter((w) => w.ownerId === snapshot.attention!.viewerId).map((w) => w.id));
	// Unended work whose baseline or published revision canonical has moved past. A published revision canonical
	// already contains is finished, not behind.
	const behind = (snapshot.reconciliation?.workspaces ?? [])
		.filter((row) => row.relation === "diverged" || (row.relation === "behind" && row.basis === "baseline"))
		.flatMap((row) => {
			const w = workspaces.find((w) => w.id === row.workspaceId);
			return w && owned.has(w.id) && !["completed", "cancelled"].includes(w.state)
				? [{ workspaceId: w.id, title: w.title, revision: row.revision, basis: row.basis, canonicalRevision: row.canonicalRevision }]
				: [];
		});
	const canonical = (behind[0]?.canonicalRevision ?? snapshot.sourceHead ?? "").slice(0, 7);
	// One plain sentence an agent cannot miss, ahead of the structured detail.
	const summary = behind.length
		? `Canonical moved to ${canonical}. ${behind.length === 1 ? "1 of your workspaces is" : `${behind.length} of your workspaces are`} behind it: ${behind
				.slice(0, 8)
				.map((b) => `${b.title} (${b.workspaceId})`)
				.join(
					", ",
				)}${behind.length > 8 ? ` and ${behind.length - 8} more` : ""}. Reconcile each now, within your task: in its directory merge canonical with Git, verify, push, publish and propose the new revision. Ask the user only for conflicts or failing checks.`
		: undefined;
	const overlaps = (snapshot.overlaps ?? [])
		.filter((o) => o.workspaces.some((id) => owned.has(id)))
		.toSorted((a, b) => a.surface.localeCompare(b.surface) || a.id.localeCompare(b.id));
	return {
		available: true as const,
		...(summary ? { summary } : {}),
		canonicalRevision: snapshot.sourceHead,
		behind,
		ancestryUnavailable: snapshot.attention.ancestryUnavailable,
		overlapCount: overlaps.length,
		overlapsTruncated: overlaps.length > 16,
		overlaps: overlaps.slice(0, 16).map((o) => ({
			path: o.surface,
			trust: o.evidence,
			workspaces: o.workspaces.map((id) => {
				const w = workspaces.find((w) => w.id === id);
				return {
					workspaceId: id,
					ownerId: w?.ownerId,
					reportedRevision: w?.headRevision,
					publishedRevision: w?.publishedRevision,
					report: snapshot.asOf === undefined ? "unknown" : reportFreshness(w?.lastReportAt, snapshot.asOf).state,
				};
			}),
			instruction:
				"Reported shared paths are an early warning, not a conflict verdict. Inspect the other workspace's exact changes and report freshness before adapting your authorized work.",
		})),
		canonicalUpdates: Object.entries(snapshot.workspaceUpdates ?? {})
			.filter(([id, update]) => owned.has(id) && update.status === "available")
			.map(([workspaceId, update]) => ({
				workspaceId,
				revision: update.revision,
				trust: update.trust,
				instruction: "Inspect get_workspace_updates for exact canonical changes and reported path overlap.",
			})),
		reconciliation: snapshot.attention.items
			.filter((item) => item.actions.includes("reconcile_with_git"))
			.map((item) => ({
				workspaceId: item.workspaceId,
				...(item.subject === "change" ? { proposalId: item.id } : {}),
				revision: item.revision,
				base: item.base,
				blockers: item.blockers,
				action: "reconcile_with_git" as const,
				continuation: {
					tool: "attach_workspace",
					workspaceId: item.workspaceId,
					instruction:
						"Continue through the owner's authorized connection in the existing attached execution, or explicitly detach before replacing it.",
				},
				instruction: item.blockers.some((b) => b.kind === "canonical_relation" && b.relation === "unrelated")
					? "Inspect the unrelated histories before choosing how to reconcile them."
					: "Within the user's authorized task, preserve working changes, fetch and merge canonical in this workspace, verify, push, publish and propose the new exact revision with fresh evidence. Ask for judgment if needed. Human approval is still required before promotion.",
			})),
		instruction:
			"These are current reconciliation needs on your owner's authorized workspaces. Handle those within your task before reporting readiness; leave the exact workspace and revision as a continuation handoff if work remains. Divergence is not proof of conflicts. Unavailable ancestry needs inspection before claiming readiness. Cruce does not execute or wake agents.",
	};
}

/** Connection-local subscriptions to a read-only resource; every refresh rechecks remote authority. */
export function coordinationResource(server: McpServer, uri: string, read: () => Promise<ReturnType<typeof coordinationContext>>) {
	let subscribed = false;
	let fingerprint: string | undefined;
	let pending: Promise<ReturnType<typeof coordinationContext>> | undefined;
	const refresh = () => {
		// Tool responses queue a fresh read after any poll that began before their mutation.
		const nextRead = (pending ?? Promise.resolve()).then(async () => {
			let context: ReturnType<typeof coordinationContext>;
			try {
				context = await read();
			} catch {
				// Never replay cached authorized data after a failed or revoked read, or fail a completed mutation.
				context = { available: false, instruction: "Coordination state unavailable. Read get_repository before reporting readiness." };
			}
			const next = JSON.stringify(context);
			if (subscribed && fingerprint !== undefined && next !== fingerprint) {
				try {
					await server.server.sendResourceUpdated({ uri });
				} catch {
					// Notification transport failure must not turn an already completed tool into an error.
					return context;
				}
			}
			fingerprint = next;
			return context;
		});
		pending = nextRead;
		void nextRead.finally(() => {
			if (pending === nextRead) pending = undefined;
		});
		return nextRead;
	};
	server.registerResource(
		"repository_coordination",
		uri,
		{
			mimeType: "application/json",
			description: "Current exact-revision reconciliation needs and reported path overlap. Subscribe to changes; read again when notified.",
		},
		async () => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await refresh()) }] }),
	);
	server.server.registerCapabilities({ resources: { subscribe: true, listChanged: false } });
	server.server.setRequestHandler("resources/subscribe", async (request) => {
		if (request.params.uri !== uri) throw new Error("Unknown coordination resource");
		await refresh();
		subscribed = true;
		return {};
	});
	server.server.setRequestHandler("resources/unsubscribe", async (request) => {
		if (request.params.uri !== uri) throw new Error("Unknown coordination resource");
		subscribed = false;
		return {};
	});
	return {
		refresh,
		poll: async () => {
			if (subscribed) await (pending ?? refresh());
		},
	};
}
