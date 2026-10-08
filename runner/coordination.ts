import type { McpServer } from "@modelcontextprotocol/server";
import { reportFreshness } from "../src/core/reconciliation.ts";
import type { RepositorySnapshot } from "../src/shared/platform.ts";

/** Current controller state, not an assignment, acknowledgement or agent conversation. */
export function coordinationContext(
	snapshot: Pick<RepositorySnapshot, "attention" | "sourceHead"> &
		Partial<Pick<RepositorySnapshot, "workspaces" | "overlaps" | "asOf" | "workspaceUpdates" | "reconciliation">>,
	/** Workspaces attached through this bridge or checkout; only these are asked to merge canonical without the user. */
	attached: ReadonlySet<string> = new Set(),
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
				? [
						{
							workspaceId: w.id,
							title: w.title,
							attached: attached.has(w.id),
							revision: row.revision,
							basis: row.basis,
							canonicalRevision: row.canonicalRevision,
						},
					]
				: [];
		});
	const canonical = (behind[0]?.canonicalRevision ?? snapshot.sourceHead ?? "").slice(0, 7);
	const named = (list: typeof behind) =>
		`${list
			.slice(0, 8)
			.map((b) => `${b.title} (${b.workspaceId})`)
			.join(", ")}${list.length > 8 ? ` and ${list.length - 8} more` : ""}`;
	const here = behind.filter((b) => b.attached),
		elsewhere = behind.filter((b) => !b.attached);
	// Plain sentences an agent cannot miss, ahead of the structured detail. Work is updated just before it is
	// proposed, so review happens once on the revision that would land; other workspaces wait for the user.
	const summary = behind.length
		? [
				`Canonical moved to ${canonical}.`,
				here.length &&
					`Attached here and behind it: ${named(here)}. Before publishing or proposing, merge canonical into ${here.length === 1 ? "it" : "each"} with Git in its directory, verify, push, publish and propose the new revision; ask the user only for conflicts or failing checks.`,
				elsewhere.length &&
					`${here.length ? "Also behind" : "Your workspaces behind it"}, not attached here: ${named(elsewhere)}. Update ${elsewhere.length === 1 ? "it" : "one"} only when the user asks: attach_workspace, then merge canonical before proposing.`,
			]
				.filter(Boolean)
				.join(" ")
		: undefined;
	const overlaps = (snapshot.overlaps ?? [])
		.filter((o) => o.workspaces.some((id) => owned.has(id)))
		.toSorted((a, b) => a.surface.localeCompare(b.surface) || a.id.localeCompare(b.id));
	const canonicalUpdates = Object.entries(snapshot.workspaceUpdates ?? {})
		.filter(([id, update]) => owned.has(id) && update.status === "available")
		.map(([workspaceId, update]) => ({ workspaceId, revision: update.revision, trust: update.trust }));
	const reconciliation = snapshot.attention.items
		.filter((item) => item.actions.includes("reconcile_with_git"))
		.map((item) => ({
			workspaceId: item.workspaceId,
			attached: attached.has(item.workspaceId),
			...(item.subject === "change" ? { proposalId: item.id } : {}),
			revision: item.revision,
			base: item.base,
			blockers: item.blockers,
			action: "reconcile_with_git" as const,
			...(item.blockers.some((b) => b.kind === "canonical_relation" && b.relation === "unrelated")
				? { note: "Inspect the unrelated histories before choosing how to reconcile them." }
				: {}),
		}));
	// Each instruction is stated once, and only when its subject is present: this block rides on every tool response.
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
		})),
		canonicalUpdates,
		reconciliation,
		instructions: [
			overlaps.length &&
				"Reported shared paths are an early warning, not a conflict verdict. Inspect the other workspace's exact changes and report freshness before adapting your authorized work.",
			canonicalUpdates.length && "Inspect get_workspace_updates for exact canonical changes and reported path overlap.",
			reconciliation.length &&
				"Merge canonical into an attached workspace before publishing or proposing it: preserve working changes, fetch and merge canonical with Git, verify, push, publish and propose the new exact revision with fresh evidence. Update a workspace that is not attached here only when the user asks, through attach_workspace in the owner's existing execution or after an explicit detach. Human approval is still required before promotion.",
			"Divergence is not proof of conflicts. Unavailable ancestry needs inspection before claiming readiness. If work remains when you stop, name the exact workspace and revision for continuation. Cruce does not execute or wake agents.",
		].filter((text): text is string => !!text),
	};
}

/**
 * Full coordination detail when it changed since the last tool response on this connection, otherwise one line.
 * The bridge appends this to every response; repeating identical state only spends the agent's context.
 */
export function coordinationDetail() {
	let previous: string | undefined;
	return (context: ReturnType<typeof coordinationContext>) => {
		const text = JSON.stringify(context);
		if (context.available && text === previous)
			return "Current coordination: unchanged since the previous Cruce response. Read the repository_coordination resource for full detail.";
		previous = text;
		return `Current coordination: ${text}`;
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
