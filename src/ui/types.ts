import type { RepositorySummary } from "../shared/coordination.ts";
import type { Namespace, NamespaceRole, Repository, ResourcePolicy, ResourceStorage, Team } from "../shared/platform.ts";
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
	budget?: { used: number; limit: number; resetsAt: number };
	permissions: { maintain: boolean; owner: boolean };
};
