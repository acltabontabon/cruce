/** These paths carry standard Git smart HTTP, never a second command language. */
export function gitRemotePath(namespaceId: string, repositoryId: string, workspaceId?: string) {
	return `/mcp/git/${encodeURIComponent(namespaceId)}/${encodeURIComponent(repositoryId)}/${encodeURIComponent(workspaceId ?? "canonical")}.git`;
}
export function parseGitRoute(url: URL) {
	const match = /^\/mcp\/git\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
		url.pathname,
	);
	if (!match) return undefined;
	return {
		namespaceId: match[1],
		repositoryId: match[2],
		workspaceId: match[3] === "canonical" ? undefined : match[3],
		endpoint: match[4],
	};
}
