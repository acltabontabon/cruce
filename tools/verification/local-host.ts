import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../../src/core/errors.ts";
import { type RepositoryHost, ResourceBoundary } from "../../src/worker/artifacts.ts";
import { convergenceRuntime, nativeGit, runConvergenceScenario } from "./convergence.ts";

/** Only the provider boundary is substituted; all publication/promotion fetches and pushes are real Git. */
export async function localConvergence() {
	const root = await mkdtemp(join(tmpdir(), "cruce-convergence-host-"));
	const repositories = new Map<string, { name: string; id: string; remote: string; description: string }>();
	const tokens = new Map<string, { name: string; scope: "read" | "write" }>();
	let origin = "",
		issued = 0;
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url!, origin);
			const match = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
			if (!match || !repositories.has(match[1])) return void res.writeHead(404).end();
			const [, name, endpoint] = match;
			const service = endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
			if (!["git-upload-pack", "git-receive-pack"].includes(service!)) return void res.writeHead(400).end();
			const token = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (!token || token.name !== name || (service === "git-receive-pack" && token.scope !== "write"))
				return void res.writeHead(403).end();
			const advertisement = endpoint === "info/refs";
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const bytes = execFileSync(
				"git",
				[
					"-c",
					"core.hooksPath=/dev/null",
					service!.replace("git-", ""),
					"--stateless-rpc",
					...(advertisement ? ["--advertise-refs"] : []),
					join(root, `${name}.git`),
				],
				{ input: advertisement ? undefined : Buffer.concat(chunks), stdio: "pipe" },
			);
			const prefix = `# service=${service}\n`;
			res.writeHead(200, { "content-type": `application/x-${service}-${advertisement ? "advertisement" : "result"}` });
			res.end(
				advertisement ? Buffer.concat([Buffer.from(`${(prefix.length + 4).toString(16).padStart(4, "0")}${prefix}0000`), bytes]) : bytes,
			);
		} catch {
			res.writeHead(500).end("Local Git transport failed");
		}
	});
	const info = async (name: string) => {
		const repository = repositories.get(name);
		if (!repository) throw new DomainError(404, "Local provider repository absent");
		return repository;
	};
	const host: RepositoryHost = {
		info,
		ensure: async (name, description, defaultBranch = "main") => {
			const existing = repositories.get(name);
			if (existing) {
				assert.equal(existing.description, description);
				return { ...existing, created: false };
			}
			await nativeGit(["init", "--bare", `--initial-branch=${defaultBranch}`, join(root, `${name}.git`)]);
			const repository = { name, id: name, remote: `${origin}/${name}.git`, description };
			repositories.set(name, repository);
			return { ...repository, created: true };
		},
		fork: async (source, name, description) => {
			const existing = repositories.get(name);
			if (existing) return { ...existing, created: false };
			await info(source);
			await nativeGit(["clone", "--bare", join(root, `${source}.git`), join(root, `${name}.git`)]);
			const repository = { name, id: name, remote: `${origin}/${name}.git`, description };
			repositories.set(name, repository);
			return { ...repository, created: true };
		},
		remove: async (name, expectedId) => {
			if (!repositories.has(name)) return true;
			assert.equal((await info(name)).id, expectedId);
			await rm(join(root, `${name}.git`), { recursive: true });
			repositories.delete(name);
			return true;
		},
		gitRequest: async () => {
			throw new Error("Scenario uses provider Git directly, not the deployed gateway");
		},
		withToken: async (name, scope, fn) => {
			await info(name);
			const tokenId = `local-token-${++issued}`;
			tokens.set(tokenId, { name, scope });
			try {
				return { result: await fn(tokenId), tokenId };
			} finally {
				tokens.delete(tokenId);
			}
		},
	};
	const originalHost = ResourceBoundary.prototype.host;
	const f = convergenceRuntime("local-convergence");
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		origin = `http://127.0.0.1:${address.port}`;
		// Standalone verifier and Vitest share this narrowly scoped fixture substitution.
		ResourceBoundary.prototype.host = async function () {
			return this.resources.namespace === f.namespace ? host : originalHost.call(this);
		};
		const result = await runConvergenceScenario(f, host);
		assert.equal(tokens.size, 0);
		assert.equal(repositories.size, 3, "Only canonical, retained source and evidence survive");
		return result;
	} finally {
		ResourceBoundary.prototype.host = originalHost;
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}
