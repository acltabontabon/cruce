/** A requested target, never authority. Consent validates it against current repository access. */
export interface RepositoryConsentTarget {
	namespaceId: string;
	repositoryId: string;
}
const prefix = "cruce-repository-v1:";
const id = /^[a-zA-Z0-9-]{1,160}$/;
export function repositoryConsentState(target: RepositoryConsentTarget, nonce: string) {
	if (![target.namespaceId, target.repositoryId, nonce].every((value) => id.test(value)))
		throw new Error("Valid repository consent IDs and nonce required");
	return `${prefix}${target.namespaceId}:${target.repositoryId}:${nonce}`;
}
export function repositoryConsentTarget(state?: string): RepositoryConsentTarget | undefined {
	if (!state?.startsWith(prefix)) return undefined;
	const values = state.slice(prefix.length).split(":");
	if (values.length !== 3 || !values.every((value) => id.test(value))) throw new Error("Invalid repository consent context");
	return { namespaceId: values[0], repositoryId: values[1] };
}
