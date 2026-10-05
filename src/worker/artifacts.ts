import { DomainError } from "../core/errors.ts";
import type { ResourceAccount } from "../shared/platform.ts";
import { type SealingEnv, seal, unseal } from "./sealing.ts";
import type { Store } from "./store.ts";

/** Resource calls use only the namespace's explicitly connected, sealed credential. */
export interface RepoRef {
	name: string;
	id: string;
	remote: string;
	created: boolean;
}

export interface RepositoryHost {
	ensure(name: string, description: string, defaultBranch?: string): Promise<RepoRef>;
	fork(source: string, target: string, description: string): Promise<RepoRef>;
	remove(name: string, expectedId?: string): Promise<boolean>;
	gitRequest(name: string, request: Request, expectedId?: string): Promise<Response>;
	info(name: string): Promise<{ name: string; description?: string | null; remote: string; id?: string }>;
	withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>): Promise<{ result: T; tokenId: string }>;
}

const API = "https://api.cloudflare.com/client/v4";
type Send = typeof fetch;

async function cloudflare<T>(send: Send, token: string, path: string, init: RequestInit = {}): Promise<T> {
	const response = await send(`${API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
	});
	const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
	if (!response.ok || body.success === false)
		throw new DomainError(
			[404, 409, 429].includes(response.status) ? response.status : 502,
			`Cloudflare API ${path.split("?")[0]}: ${body.errors?.map((e) => e.message).join("; ") || response.status}`,
		);
	return body.result as T;
}

/** Artifacts in a connected account, through the public REST API. Same credential discipline as the binding host. */
export class ArtifactsRestHost implements RepositoryHost {
	constructor(
		readonly accountId: string,
		readonly namespace: string,
		private readonly token: string,
		private readonly send: Send = fetch,
	) {}
	private path(suffix = "") {
		return `/accounts/${this.accountId}/artifacts/namespaces/${this.namespace}${suffix}`;
	}
	async info(name: string) {
		return cloudflare<{ name: string; description?: string | null; remote: string; id: string }>(
			this.send,
			this.token,
			this.path(`/repos/${name}`),
		);
	}
	private async namespaceReady() {
		try {
			await cloudflare(this.send, this.token, this.path());
		} catch (error) {
			if (!(error instanceof DomainError) || error.status !== 404) throw error;
			try {
				await cloudflare(this.send, this.token, `/accounts/${this.accountId}/artifacts/namespaces`, {
					method: "POST",
					body: JSON.stringify({ namespace: this.namespace }),
				});
			} catch (createError) {
				// Another repository in this namespace may have created the same namespace.
				if (!(createError instanceof DomainError) || createError.status !== 409) throw createError;
				await cloudflare(this.send, this.token, this.path());
			}
		}
	}
	private async revokeOutstanding(name: string) {
		for (let page = 0; page < 20; page++) {
			const tokens = await cloudflare<{ id: string }[]>(
				this.send,
				this.token,
				this.path(`/repos/${name}/tokens?state=active&per_page=100`),
			);
			for (const token of tokens) await this.revoke(token.id);
			if (tokens.length < 100) return;
		}
		throw new DomainError(503, "Repository token reconciliation needs another retry");
	}
	async ensure(name: string, description: string, defaultBranch = "main"): Promise<RepoRef> {
		await this.namespaceReady();
		try {
			const info = await this.info(name);
			if (info.description !== description) throw new DomainError(409, "Artifacts repository ownership mismatch");
			await this.revokeOutstanding(name);
			return { name: info.name, id: info.id, remote: info.remote, created: false };
		} catch (error) {
			if ((error as DomainError).status !== 404) throw error;
		}
		const created = await cloudflare<{ id: string; name: string; remote: string; token: string }>(
			this.send,
			this.token,
			this.path("/repos"),
			{
				method: "POST",
				body: JSON.stringify({ name, description, default_branch: defaultBranch }),
			},
		);
		// The creation token is long-lived; Cruce never keeps it.
		await this.revokeOutstanding(name);
		return { name: created.name, id: created.id, remote: created.remote, created: true };
	}
	async fork(source: string, target: string, description: string): Promise<RepoRef> {
		try {
			const old = await this.info(target);
			if (old.description !== description) throw new DomainError(409, "Fork ownership mismatch");
			await this.revokeOutstanding(target);
			return { ...old, created: false };
		} catch (error) {
			if ((error as DomainError).status !== 404) throw error;
		}
		const created = await cloudflare<{ id: string; name: string; remote: string }>(
			this.send,
			this.token,
			this.path(`/repos/${source}/fork`),
			{ method: "POST", body: JSON.stringify({ name: target, description, default_branch_only: true, read_only: false }) },
		);
		await this.revokeOutstanding(target);
		return { ...created, created: true };
	}

	/** Deletion is asynchronous. A retry confirms absence before releasing ownership. */
	async remove(name: string, expectedId?: string): Promise<boolean> {
		try {
			const info = await this.info(name);
			if (expectedId && info.id !== expectedId) throw new DomainError(409, "Artifacts repository identity changed");
			await cloudflare(this.send, this.token, this.path(`/repos/${name}`), { method: "DELETE" });
			return false;
		} catch (error) {
			if (error instanceof DomainError && error.status === 404) return true;
			throw error;
		}
	}
	async gitRequest(name: string, request: Request, expectedId?: string): Promise<Response> {
		const info = await this.info(name);
		if (expectedId && info.id !== expectedId) throw new DomainError(409, "Artifacts repository identity changed");
		const remote = new URL(info.remote);
		if (
			remote.protocol !== "https:" ||
			remote.hostname !== `${this.accountId}.artifacts.cloudflare.net` ||
			remote.username ||
			remote.password ||
			remote.search ||
			remote.hash
		)
			throw new DomainError(502, "Invalid Artifacts Git remote");
		const input = new URL(request.url);
		const endpoint = input.pathname.endsWith("/info/refs") ? "info/refs" : input.pathname.split("/").at(-1)!;
		const service = endpoint === "info/refs" ? input.searchParams.get("service") : endpoint;
		if (
			!["git-upload-pack", "git-receive-pack"].includes(service ?? "") ||
			(endpoint === "info/refs" ? request.method !== "GET" : request.method !== "POST")
		)
			throw new DomainError(400, "Unsupported Git request");
		const target = `${remote.href}/${endpoint}${endpoint === "info/refs" ? `?service=${service}` : ""}`;
		return (
			await this.withToken(name, service === "git-receive-pack" ? "write" : "read", async (token) => {
				const headers = new Headers({ authorization: `Bearer ${token}` });
				for (const key of ["content-type", "content-encoding", "git-protocol"]) {
					const value = request.headers.get(key);
					if (value) headers.set(key, value);
				}
				const response = await this.send(target, {
					method: request.method,
					headers,
					body: request.method === "POST" ? await boundedBody(request) : undefined,
					redirect: "manual",
				});
				// Consume before revoking the token; return only Git payload headers, never cookies or redirects.
				if (!response.ok) {
					await response.body?.cancel();
					throw new DomainError(502, "Artifacts Git request failed");
				}
				const bytes = await boundedBody(response);
				return new Response(bytes, {
					headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" },
				});
			})
		).result;
	}

	async withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>) {
		const t = await cloudflare<{ id: string; plaintext: string }>(this.send, this.token, this.path("/tokens"), {
			method: "POST",
			body: JSON.stringify({ repo: name, scope, ttl: 60 }),
		});
		try {
			return { result: await fn(t.plaintext), tokenId: t.id };
		} finally {
			await this.revoke(t.id);
		}
	}
	private async revoke(id: string) {
		try {
			await cloudflare(this.send, this.token, this.path(`/tokens/${id}`), { method: "DELETE" });
		} catch (e) {
			if (!(e instanceof DomainError) || e.status !== 404) throw e;
		}
	}
}

interface StoredAccount extends ResourceAccount {
	sealed?: string;
}
export interface NamespaceResources {
	namespace: string;
}

export class ResourceBoundary {
	constructor(
		readonly store: Store,
		readonly env: SealingEnv,
		readonly resources: NamespaceResources,
		readonly send: Send = fetch,
	) {}
	/** Public view: never includes the credential. */
	account(): ResourceAccount | undefined {
		const stored = this.store.get<StoredAccount>("resource-account");
		if (stored) {
			const { sealed: _secret, ...view } = stored;
			return view;
		}
		return undefined;
	}
	async connect(input: { accountId: string; token: string; label?: string }, actor: string): Promise<ResourceAccount> {
		if (!/^[0-9a-f]{32}$/.test(input.accountId)) throw new DomainError(400, "Cloudflare account ID required");
		if (input.token.length < 20 || input.token.length > 400) throw new DomainError(400, "Cloudflare API token required");
		await cloudflare(this.send, input.token, `/accounts/${input.accountId}/artifacts/namespaces?limit=1`);
		const account: StoredAccount = {
			mode: "connected",
			accountId: input.accountId,
			label: input.label?.slice(0, 80) || "Connected Cloudflare account",
			credential: "stored",
			connectedBy: actor,
			at: Date.now(),
			sealed: await seal(this.env, { token: input.token }),
		};
		this.store.put("resource-account", account);
		return this.account()!;
	}
	disconnect() {
		this.store.delete("resource-account");
	}
	private async token(): Promise<string> {
		const stored = this.store.get<StoredAccount>("resource-account");
		if (!stored?.sealed) throw new DomainError(409, "Connect a Cloudflare account with an Artifacts token first");
		return (await unseal<{ token: string }>(this.env, stored.sealed)).token;
	}
	async host(): Promise<RepositoryHost> {
		const account = this.account();
		if (!account) throw new DomainError(409, "No Cloudflare account connected");
		return new ArtifactsRestHost(account.accountId, this.resources.namespace, await this.token(), this.send);
	}
}

/** Bounded transfer, including chunked requests. This is a Cruce limit, not an Artifacts repository limit. */
export async function boundedBody(message: Request | Response, limit = 32 * 1024 * 1024): Promise<ArrayBuffer> {
	const reader = message.body?.getReader();
	if (!reader) return new ArrayBuffer(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new DomainError(413, "Git transfer exceeds the 32 MiB gateway limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes.buffer;
}
