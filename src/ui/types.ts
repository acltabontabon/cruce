import type { RepositorySummary } from "../shared/coordination.ts";
import type {
	Namespace,
	NamespaceDeletionView,
	NamespaceLifecycle,
	NamespaceRole,
	Repository,
	ResourcePolicy,
	ResourceStorage,
	Team,
} from "../shared/platform.ts";
export type NamespaceView = {
	repositorySummaries?: RepositorySummary[];
	repositoryFailures?: { repositoryId: string; message: string }[];
	activity?: {
		id: string;
		kind: string;
		actor: import("../shared/platform.ts").Actor;
		repositoryId: string;
		repositoryName: string;
		summary: string;
		at: number;
	}[];
	namespace: Namespace;
	role: NamespaceRole;
	repositories: Repository[];
	members: Record<string, NamespaceRole>;
	people: { id: string; name: string; email: string }[];
	teams: Team[];
	policy: ResourcePolicy;
	storage: ResourceStorage;
	permissions: { maintain: boolean; owner: boolean };
	lifecycle?: NamespaceLifecycle;
	/** Owner only: what permanent deletion would end, what stops it, and its progress once authorized. */
	deletion?: NamespaceDeletionView;
};
