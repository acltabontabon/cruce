import type { RepositoryController } from "../core/platform.ts";
import { reconciliation } from "../core/reconciliation.ts";
import type { GitRelation, ObservationStatus } from "../shared/platform.ts";
import type { GitWorkspace } from "./git/workspace.ts";

/** One bounded all-parent commit graph per request, shared across every comparison. */
export async function readReconciliation(c: RepositoryController, observation: ObservationStatus, git: GitWorkspace) {
	const canonical = observation.canonical?.deleted ? undefined : (observation.canonical?.revision ?? c.state.sourceHead);
	const relations = new Map<string, GitRelation>();
	const ancestry = new Map<string, boolean>();
	const parents = new Map<string, string[]>();
	const graphs = new Map<string, Set<string> | undefined>();
	const budget = { remaining: 20_000, bytes: 64 * 1024 * 1024 };
	const graph = async (revision: string) => {
		if (graphs.has(revision)) return graphs.get(revision);
		let result: Set<string> | undefined;
		try {
			result = await git.ancestors(revision, parents, budget);
		} catch {
			/* Missing, corrupt or bounded source remains unknown. */
		}
		graphs.set(revision, result);
		return result;
	};
	const upstream = canonical ? await graph(canonical) : undefined;
	for (const w of c.state.workspaces.filter((w) => !["completed", "cancelled"].includes(w.state))) {
		const revision = w.publishedRevision ?? w.baseRevision;
		const source = await graph(revision);
		if (source && upstream && canonical) {
			relations.set(
				w.id,
				revision === canonical
					? "current"
					: source.has(canonical)
						? "ahead"
						: upstream.has(revision)
							? "behind"
							: [...source].some((id) => upstream.has(id))
								? "diverged"
								: "unrelated",
			);
		}
		if (w.publishedRevision && source)
			for (const p of c.state.promotions.filter((p) => p.state === "complete"))
				ancestry.set(`${p.to}:${w.publishedRevision}`, source.has(p.to));
	}
	return reconciliation(c, observation, relations, ancestry);
}
