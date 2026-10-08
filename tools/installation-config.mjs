import { pathToFileURL } from "node:url";

/** Pure installation validation; never creates resources or rotates secrets. */
export function installationConfig(env, requireLive = false) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
	const artifactsNamespace = env.CRUCE_ARTIFACTS_NAMESPACE?.trim() || "cruce";
	const workerName = env.CRUCE_WORKER_NAME?.trim() || "cruce";
	const origin = env.CRUCE_PUBLIC_ORIGIN?.trim() || "http://localhost:5173";
	if (accountId && !/^[0-9a-f]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
	if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(artifactsNamespace))
		throw new Error("CRUCE_ARTIFACTS_NAMESPACE must be a stable Artifacts namespace name");
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("CRUCE_WORKER_NAME must be a Worker name");
	let url;
	try {
		url = new URL(origin);
	} catch {
		throw new Error("CRUCE_PUBLIC_ORIGIN must be an HTTP(S) origin");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw new Error("CRUCE_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path or a query");
	if (requireLive) {
		if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID once for this installation");
		if (!env.CRUCE_PUBLIC_ORIGIN || url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname))
			throw new Error("Set CRUCE_PUBLIC_ORIGIN to the installation's public HTTPS origin");
		if (!env.CRUCE_ACCESS_ISSUER || !env.CRUCE_ACCESS_AUD)
			throw new Error("Set CRUCE_ACCESS_ISSUER and CRUCE_ACCESS_AUD for this installation");
	}
	return { accountId, artifactsNamespace, workerName, origin: url.origin, domain: url.protocol === "https:" ? url.hostname : undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	installationConfig(process.env, true);
	console.log("Installation configuration is valid. Storage is configured once; no customer Cloudflare tokens are required.");
}
