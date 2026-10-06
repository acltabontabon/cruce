import { STATE_LIMITS } from "../shared/limits.ts";
import type { NamespaceState, RepositoryState } from "../shared/platform.ts";
import { DomainError } from "./errors.ts";

export function assertStateBytes(state: unknown, limit: number = STATE_LIMITS.stateBytes) {
	if (new TextEncoder().encode(JSON.stringify(state)).length > limit)
		throw new DomainError(413, "Coordination state exceeds its byte limit; inspect capacity before adding work");
}
export function assertRepositoryCapacity(state: RepositoryState) {
	for (const field of ["workspaces", "artifacts", "proposals", "verifications", "promotions"] as const)
		if (state[field].length > STATE_LIMITS[field])
			throw new DomainError(409, "Repository record capacity reached; inspect retained records before adding work");
	assertStateBytes(state);
}
export function assertNamespaceCapacity(state: NamespaceState) {
	if (
		state.repositories.length > STATE_LIMITS.repositories ||
		Object.keys(state.members).length > 1000 ||
		state.teams.length > 100 ||
		state.invitations.length > 1000
	)
		throw new DomainError(409, "Namespace record capacity reached; inspect retained records before adding work");
	assertStateBytes(state);
}
