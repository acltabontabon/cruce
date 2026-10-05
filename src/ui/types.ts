import type { RepositorySummary } from "../shared/coordination.ts";
import type { Namespace, NamespaceRole, Repository, ResourcePolicy, Team } from "../shared/platform.ts";
export type NamespaceView = {
	repositorySummaries?: RepositorySummary[];
	activity?: { id: string; repositoryId: string; repositoryName: string; summary: string; at: number }[];
	namespace: Namespace;
	role: NamespaceRole;
	repositories: Repository[];
	members: Record<string, NamespaceRole>;
	people: { id: string; name: string; email: string }[];
	teams: Team[];
	policy: ResourcePolicy;
	account?: { accountId: string; label: string };
	permissions: { maintain: boolean; owner: boolean };
};
