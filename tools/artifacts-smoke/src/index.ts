import { env } from "cloudflare:workers";

// Local-only smoke Worker for verifying Artifacts access through the Workers binding.
// It returns repo tokens to the caller, so it must never be deployed.

function json(data: unknown, status = 200) {
	return Response.json(data, { status });
}

async function body<T>(request: Request): Promise<T> {
	return (await request.json().catch(() => ({}))) as T;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
			return json({ error: "local only" }, 403);
		}
		const parts = url.pathname.split("/").filter(Boolean);

		try {
			if (request.method === "GET" && parts[0] === "repos" && parts.length === 1) {
				const page = await env.ARTIFACTS.list({ limit: 50 });
				return json(page.repos.map((r) => ({ name: r.name, source: r.source, lastPushAt: r.lastPushAt })));
			}
			if (request.method === "POST" && parts[0] === "repos" && parts.length === 1) {
				const { name, description } = await body<{ name: string; description?: string }>(request);
				const created = await env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" });
				return json({
					name: created.name,
					remote: created.remote,
					defaultBranch: created.defaultBranch,
					token: created.token,
				});
			}
			if (parts[0] !== "repos" || !parts[1]) return json({ error: "not found" }, 404);

			const name = parts[1];
			const action = parts[2];

			if (request.method === "DELETE" && !action) {
				return json({ deleted: await env.ARTIFACTS.delete(name) });
			}

			using repo = await env.ARTIFACTS.get(name);

			if (request.method === "GET" && action === "info") return json(await repo.info());
			if (request.method === "GET" && action === "log") {
				return json(await repo.log({ ref: url.searchParams.get("ref") ?? "main", limit: 20 }));
			}
			if (request.method === "GET" && action === "file") {
				const file = await repo.readFile({
					ref: url.searchParams.get("ref") ?? "main",
					path: url.searchParams.get("path") ?? "README.md",
				});
				if (!file) return json({ error: "missing" }, 404);
				return json({ type: file.type, content: await file.text() });
			}
			if (request.method === "POST" && action === "tokens") {
				const { scope, ttl } = await body<{ scope?: "read" | "write"; ttl?: number }>(request);
				return json(await repo.createToken(scope ?? "read", ttl ?? 600));
			}
			if (request.method === "GET" && action === "tokens") return json(await repo.listTokens());
			if (request.method === "POST" && action === "revoke") {
				const { id } = await body<{ id: string }>(request);
				return json({ revoked: await repo.revokeToken(id) });
			}
			if (request.method === "POST" && action === "fork") {
				const { target } = await body<{ target: string }>(request);
				const forked = await repo.fork(target, { defaultBranchOnly: true, readOnly: false });
				return json({ name: forked.name, remote: forked.remote, defaultBranch: forked.defaultBranch });
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			return json({ error: String(error), detail: (error as { code?: string }).code }, 500);
		}
	},
} satisfies ExportedHandler;
