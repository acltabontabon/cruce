import { STATE_LIMITS } from "../shared/limits.ts";
import type { ArchiveBundle, RepositoryState } from "../shared/platform.ts";

/** Repository state recorded before archival counted changes and bundles; nothing was archived then. */
export function archiveLayout(state: RepositoryState) {
	state.proposalCount ??= state.proposals.length;
	state.archiveCount ??= 0;
	return state;
}

/**
 * Finished work that can leave hot state. A bundle is one ended workspace with no live fork or
 * cleanup, every change closed, every promotion failed or settled, and none of its promotions among
 * the newest accepted ones. Bundles keep hot state referentially closed: nothing left behind names
 * an archived record, so live views, readiness and reconciliation never need the archive.
 */
export function finishedWork(state: RepositoryState, now: number): ArchiveBundle[] {
	const recent = new Set(
		state.promotions
			.filter((p) => p.state === "complete")
			.slice(-STATE_LIMITS.recentPromotions)
			.map((p) => p.id),
	);
	const bundles: ArchiveBundle[] = [];
	for (const workspace of state.workspaces) {
		if (!["completed", "cancelled"].includes(workspace.state)) continue;
		if (workspace.fork && workspace.fork.state !== "deleted") continue;
		if (workspace.cleanup && workspace.cleanup.state !== "complete") continue;
		const proposals = state.proposals.filter((p) => p.workspaceId === workspace.id);
		if (proposals.some((p) => !["rejected", "promoted"].includes(p.state))) continue;
		const ids = new Set(proposals.map((p) => p.id));
		const promotions = state.promotions.filter((p) => ids.has(p.proposalId));
		if (
			promotions.some(
				(p) => recent.has(p.id) || !(p.state === "failed" || (p.state === "complete" && (!p.operation || p.operation.settled))),
			)
		)
			continue;
		const artifacts = state.artifacts.filter((a) => a.workspaceId === workspace.id);
		const published = new Set(artifacts.map((a) => a.id));
		// Evidence published here but attached to someone else's change stays until that change leaves.
		if (state.verifications.some((v) => !ids.has(v.proposalId) && v.artifactId && published.has(v.artifactId))) continue;
		bundles.push({
			sequence: state.archiveCount + bundles.length + 1,
			archivedAt: now,
			workspace,
			artifacts,
			proposals,
			verifications: state.verifications.filter((v) => ids.has(v.proposalId)),
			promotions,
		});
	}
	return bundles;
}

/** Hot state without the given bundles; the input is not modified. */
export function withoutBundles(state: RepositoryState, bundles: ArchiveBundle[]): RepositoryState {
	const gone = new Set(bundles.flatMap(bundleIds));
	const keep = <T extends { id: string }>(items: T[]) => items.filter((item) => !gone.has(item.id));
	return {
		...state,
		archiveCount: state.archiveCount + bundles.length,
		workspaces: keep(state.workspaces),
		artifacts: keep(state.artifacts),
		proposals: keep(state.proposals),
		verifications: keep(state.verifications),
		promotions: keep(state.promotions),
	};
}

/** A read-only view of hot state with archived bundles restored; never saved. */
export function withBundles(state: RepositoryState, bundles: ArchiveBundle[]) {
	const present = new Set(state.workspaces.map((w) => w.id));
	for (const b of bundles.filter((b) => !present.has(b.workspace.id))) {
		present.add(b.workspace.id);
		state.workspaces.push(b.workspace);
		state.artifacts.push(...b.artifacts);
		state.proposals.push(...b.proposals);
		state.verifications.push(...b.verifications);
		state.promotions.unshift(...b.promotions);
	}
	return state;
}

/** Every record id in a bundle, for `archived:<id>` lookups. */
export function bundleIds(bundle: ArchiveBundle) {
	return [
		bundle.workspace.id,
		...bundle.artifacts.map((a) => a.id),
		...bundle.proposals.map((p) => p.id),
		...bundle.verifications.map((v) => v.id),
		...bundle.promotions.map((p) => p.id),
	];
}
