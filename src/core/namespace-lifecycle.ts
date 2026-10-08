import type {
	Authority,
	NamespaceDeletionView,
	NamespaceState,
	Repository,
	RepositoryLifecycleView,
	ResourceStorage,
} from "../shared/platform.ts";

export interface RepositoryRetirement {
	repository: Repository;
	/** The repository's own lifecycle view, or absent when it could not be read. */
	lifecycle?: RepositoryLifecycleView;
}
/**
 * Permanent namespace deletion is the owner's decision to delete every repository in it, so it ends their unfinished
 * work exactly as repository deletion does. It waits for whatever any one repository's deletion would wait for, and for
 * an archive or restore that has not finished. A repository already being deleted is resumed, not a blocker.
 * Unavailable installation storage blocks it too, since authorizing would freeze the namespace with no way to remove
 * its repositories' cloud storage. Legacy storage can never be reached again, so instead of blocking, deletion can only
 * forget it, once the owner confirms that Cruce will not delete it.
 */
export function namespaceDeletionView(
	state: Pick<NamespaceState, "namespace" | "lifecycle" | "policy">,
	a: Authority,
	repositories: RepositoryRetirement[],
	storage: ResourceStorage | undefined,
	deletion?: { idempotencyKey: string; reason?: string; forgetStorage?: true },
): NamespaceDeletionView {
	const live = repositories.filter(({ repository }) => repository.lifecycle?.state !== "deleted");
	const blockers = [
		...(storage && !storage.ready && !storage.legacy && live.length ? [storage.reason] : []),
		...(state.policy.rules["repository.delete"] === "deny" ? ["Storage operations do not allow deleting repositories."] : []),
		...live.flatMap(({ repository, lifecycle }) =>
			!lifecycle
				? [`${repository.name}: Repository could not be read; retry when it is available.`]
				: [
						// Storage is namespace-wide and reported once above.
						...(lifecycle.state === "deleting" ? [] : lifecycle.deletionBlockers.filter((b) => storage?.ready || b !== storage?.reason)),
						...(lifecycle.transition ? ["Retry the unfinished archive or restore."] : []),
						...(repository.policy.resourceRules["repository.delete"] === "deny" ? ["Repository policy does not allow deletion."] : []),
					].map((blocker) => `${repository.name}: ${blocker}`),
		),
	];
	const sum = (pick: (u: RepositoryLifecycleView["unfinished"]) => number) =>
		live.reduce((total, { lifecycle }) => total + (lifecycle ? pick(lifecycle.unfinished) : 0), 0);
	return {
		state: state.lifecycle?.state ?? "active",
		deletable: state.namespace.kind === "shared",
		owner: a.actor.kind === "human" && !a.actor.connectionId && a.role === "owner",
		repositories: live.length,
		archived: live.filter(({ repository }) => repository.lifecycle?.state === "archived").length,
		unfinished: { workspaces: sum((u) => u.workspaces), attached: sum((u) => u.attached), changes: sum((u) => u.changes) },
		blockers,
		forgetStorage: Boolean(storage && !storage.ready && storage.legacy && live.length),
		...(deletion ? { deletion: { ...deletion, remaining: live.length } } : {}),
	};
}
