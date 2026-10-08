import { DomainError } from "../core/errors.ts";
import { TRANSFER_LIMITS } from "../shared/limits.ts";
import type { ResourceStorage } from "../shared/platform.ts";
import { diagnose } from "./diagnostics.ts";
import { ProviderIdentity, ProviderIdentityError } from "./provider-identity.ts";
import type { Store } from "./store.ts";

export type SourceReader = Pick<ArtifactsRepo, "readCommit" | "readTree" | "readFile" | "log">;

/** Resource calls use the explicitly configured installation storage. */
export interface RepoRef {
	name: string;
	id: string;
	remote: string;
	created: boolean;
}

export interface RepositoryHost {
	verifyFork?(name: string, expectedId: string, parentId: string, parentName: string): Promise<void>;
	ensure(name: string, description: string, defaultBranch?: string): Promise<RepoRef>;
	fork(source: string, target: string, description: string): Promise<RepoRef>;
	remove(name: string, expectedId?: string): Promise<boolean>;
	gitRequest(name: string, request: Request, expectedId?: string): Promise<Response>;
	info(name: string): Promise<{ name: string; description?: string | null; remote: string; id?: string }>;
	withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>): Promise<{ result: T; tokenId: string }>;
	withSource?<T>(name: string, expectedId: string, run: (source: SourceReader) => Promise<T>): Promise<T>;
}

const API = "https://api.cloudflare.com/client/v4";
/** Artifacts source reads resolve a branch, tag or commit ID; a fully qualified branch ref resolves to nothing. */
export const providerRef = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);
type Send = typeof fetch;

/**
 * Public text for a failed provider call. Provider paths, account IDs and raw provider messages stay out of
 * responses or logs. Diagnostics contain only allowlisted metadata and redacted correlation.
 */
export function providerMessage(status: number, codes: number[]) {
	if (status === 401 || status === 403 || codes.some((c) => c === 10000 || c === 1000 || c === 9109))
		return "Cloudflare rejected storage access. Ask the installation administrator to check Artifacts permissions.";
	if (status === 404) return "Cloudflare could not find the requested storage.";
	if (status === 409) return "Cloudflare reported a conflicting change. Retry the same operation.";
	if (status === 429) return "Cloudflare is rate limiting requests. Retry the same operation shortly.";
	return "Cloudflare could not complete the request. Retry the same operation.";
}
async function cloudflare<T>(send: Send, token: string, path: string, init: RequestInit = {}, maxBytes?: number): Promise<T> {
	const response = await send(`${API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
	});
	const body = (
		maxBytes
			? JSON.parse(new TextDecoder().decode(await boundedBody(response, maxBytes, "Source inspection exceeds its response limit")))
			: await response.json().catch(() => ({}))
	) as {
		success?: boolean;
		result?: T;
		errors?: { code?: number; message: string }[];
	};
	if (!response.ok || body.success === false) {
		const codes = Array.isArray(body.errors) ? body.errors.flatMap((e) => (typeof e?.code === "number" ? [e.code] : [])) : [];
		diagnose("provider_error", { provider: "rest", status: response.status });
		throw new DomainError([404, 409, 429].includes(response.status) ? response.status : 502, providerMessage(response.status, codes));
	}
	return body.result as T;
}

/** Explicit REST provider-test harness; production uses ArtifactsBindingHost. */
export class ArtifactsRestHost implements RepositoryHost {
	constructor(
		readonly accountId: string,
		readonly namespace: string,
		private readonly token: string,
		private readonly send: Send = fetch,
		readonly identities?: ProviderIdentity,
	) {}
	private path(suffix = "") {
		return `/accounts/${this.accountId}/artifacts/namespaces/${this.namespace}${suffix}`;
	}
	async withSource<T>(name: string, expectedId: string, run: (source: SourceReader) => Promise<T>) {
		if ((await this.info(name)).id !== expectedId) throw new ProviderIdentityError("Artifacts repository identity changed");
		const json = async <V>(suffix: string): Promise<V | null> => {
			try {
				return await cloudflare<V>(this.send, this.token, this.path(`/repos/${name}/${suffix}`), {}, 1_000_000);
			} catch (error) {
				if (error instanceof DomainError && error.status === 404) return null;
				throw error;
			}
		};
		return run({
			readCommit: (oid) => json<ArtifactsCommitMetadata>(`commit/${oid}`),
			readTree: (oid) => json<ArtifactsTreeEntry[]>(`tree/${oid}`),
			log: async (opts) =>
				(await json<ArtifactsCommitMetadata[]>(
					`log?${new URLSearchParams({ ref: providerRef(opts?.ref ?? "HEAD"), limit: String(opts?.limit ?? 30), offset: String(opts?.offset ?? 0) })}`,
				)) ?? [],
			readFile: async ({ ref, path }) => {
				const response = await this.send(
					`${API}${this.path(`/repos/${name}/file?${new URLSearchParams({ ref: providerRef(ref), path })}`)}`,
					{
						headers: { authorization: `Bearer ${this.token}` },
						redirect: "manual",
					},
				);
				if (response.status === 404) {
					await response.body?.cancel();
					return null;
				}
				if (!response.ok) {
					await response.body?.cancel();
					diagnose("provider_error", { provider: "rest", status: response.status });
					throw new DomainError(502, "Artifacts source read unavailable");
				}
				return new Blob([await boundedBody(response, 256_000, "File is too large for inline source inspection")]);
			},
		});
	}
	async info(name: string) {
		const info = await cloudflare<{ name: string; description?: string | null; remote: string; id: string }>(
			this.send,
			this.token,
			this.path(`/repos/${name}`),
		);
		this.identities?.check(name, info.id);
		return info;
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
		if (this.identities) await this.info(name);
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
			this.identities?.require(name);
			this.identities?.record(name, info.id);
			await this.revokeOutstanding(name);
			return { name: info.name, id: info.id, remote: info.remote, created: false };
		} catch (error) {
			if ((error as DomainError).status !== 404) throw error;
		}
		if (this.identities?.expected(name)) throw new ProviderIdentityError("Recorded Artifacts repository is missing");
		const created = await cloudflare<{ id: string; name: string; remote: string; token: string }>(
			this.send,
			this.token,
			this.path("/repos"),
			{
				method: "POST",
				body: JSON.stringify({ name, description, default_branch: defaultBranch }),
			},
		);
		this.identities?.record(name, created.id);
		// The creation token is long-lived; Cruce never keeps it.
		await this.revokeOutstanding(name);
		return { name: created.name, id: created.id, remote: created.remote, created: true };
	}
	async fork(source: string, target: string, description: string): Promise<RepoRef> {
		if (this.identities) {
			this.identities.require(source);
			await this.info(source);
		}
		try {
			const old = await this.info(target);
			if (old.description !== description) throw new DomainError(409, "Fork ownership mismatch");
			this.identities?.require(target);
			this.identities?.record(target, old.id);
			await this.revokeOutstanding(target);
			return { ...old, created: false };
		} catch (error) {
			if ((error as DomainError).status !== 404) throw error;
		}
		if (this.identities?.expected(target)) throw new ProviderIdentityError("Recorded Artifacts repository is missing");
		const created = await cloudflare<{ id: string; name: string; remote: string }>(
			this.send,
			this.token,
			this.path(`/repos/${source}/fork`),
			{ method: "POST", body: JSON.stringify({ name: target, description, default_branch_only: true, read_only: false }) },
		);
		this.identities?.record(target, created.id);
		await this.revokeOutstanding(target);
		return { ...created, created: true };
	}

	/** Deletion is asynchronous. A retry confirms absence before releasing ownership. */
	async remove(name: string, expectedId?: string): Promise<boolean> {
		try {
			const info = await this.info(name);
			if (expectedId && info.id !== expectedId) throw new ProviderIdentityError("Artifacts repository identity changed");
			await cloudflare(this.send, this.token, this.path(`/repos/${name}`), { method: "DELETE" });
			return false;
		} catch (error) {
			if (error instanceof DomainError && error.status === 404) return true;
			throw error;
		}
	}
	gitRequest(name: string, request: Request, expectedId?: string) {
		return forwardGit(this, this.accountId, this.send, name, request, expectedId);
	}

	async withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>) {
		if (this.identities) {
			this.identities.require(name);
			await this.info(name);
		}
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

const verifiedBodies = new WeakMap<Request, ArrayBuffer>();
/** Internal handoff of the gateway's already-bounded body. Keeps normal Request
 * semantics for adapters without allocating/buffering the same pack twice. */
export function bufferedGitRequest(template: Request, bytes?: ArrayBuffer) {
	if (bytes && bytes.byteLength > TRANSFER_LIMITS.gitBytes) throw new DomainError(413, "Git transfer exceeds the 32 MiB gateway limit");
	const request = new Request(template.url, {
		method: template.method,
		headers: template.headers,
		body: bytes
			? new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(bytes));
						controller.close();
					},
				})
			: undefined,
		duplex: "half",
	} as RequestInit);
	if (bytes) verifiedBodies.set(request, bytes);
	return request;
}

async function forwardGit(
	host: RepositoryHost,
	accountId: string,
	send: Send,
	name: string,
	request: Request,
	expectedId?: string,
): Promise<Response> {
	const info = await host.info(name);
	if (expectedId && info.id !== expectedId) throw new ProviderIdentityError("Artifacts repository identity changed");
	const remote = new URL(info.remote);
	if (
		remote.protocol !== "https:" ||
		remote.hostname !== `${accountId}.artifacts.cloudflare.net` ||
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
		await host.withToken(name, service === "git-receive-pack" ? "write" : "read", async (token) => {
			const headers = new Headers({ authorization: `Bearer ${token}` });
			for (const key of ["content-type", "content-encoding", "git-protocol"]) {
				const value = request.headers.get(key);
				if (value) headers.set(key, value);
			}
			// Native Worker fetch requires its global receiver, not the host instance.
			const response = await send(target, {
				method: request.method,
				headers,
				body: request.method === "POST" ? (verifiedBodies.get(request) ?? (await boundedBody(request))) : undefined,
				redirect: "manual",
			});
			// Consume before revoking the token; return only Git payload headers, never cookies or redirects.
			if (!response.ok) {
				await response.body?.cancel();
				diagnose("provider_error", { provider: "git", status: response.status });
				throw new DomainError(502, "Artifacts Git request failed");
			}
			const bytes = await boundedBody(response);
			return new Response(bytes, {
				headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" },
			});
		})
	).result;
}

export interface StorageEnv {
	CF_EVENTS_API_TOKEN?: string;
	CRUCE_OBSERVATION_QUEUE_ID?: string;
	CRUCE_OBSERVATION_QUEUE?: string;
	ARTIFACTS?: Artifacts;
	CRUCE_STORAGE_ACCOUNT_ID?: string;
	CRUCE_ARTIFACTS_NAMESPACE?: string;
}
export interface NamespaceResources {
	namespace: string;
}
export interface StorageBinding {
	accountId: string;
	namespace: string;
}

/** No provider calls or writes when inspecting configuration. */
export class ResourceBoundary {
	constructor(
		readonly store: Store,
		readonly env: StorageEnv,
		readonly resources: NamespaceResources,
		readonly send: Send = fetch,
		readonly identities = new ProviderIdentity(store),
	) {}
	storage(): ResourceStorage {
		if (this.store.get("resource-account"))
			return {
				mode: "deployment",
				ready: false,
				reason: "Existing connected-account storage requires an explicit storage transition by the administrator",
				legacy: true,
			};
		const accountId = this.env.CRUCE_STORAGE_ACCOUNT_ID;
		const namespace = this.env.CRUCE_ARTIFACTS_NAMESPACE;
		if (
			!this.env.ARTIFACTS ||
			!accountId ||
			!/^[0-9a-f]{32}$/.test(accountId) ||
			!namespace ||
			!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(namespace)
		)
			return { mode: "deployment", ready: false, reason: "Installation storage is unavailable; contact the administrator" };
		const pinned = this.store.get<StorageBinding>("storage-binding");
		if (pinned && (pinned.accountId !== accountId || pinned.namespace !== namespace))
			return { mode: "deployment", ready: false, reason: "Installation storage identity changed; restore the recorded configuration" };
		return { mode: "deployment", ready: true };
	}
	binding(): StorageBinding {
		const storage = this.storage();
		if (!storage.ready) throw new ProviderIdentityError(storage.reason);
		return { accountId: this.env.CRUCE_STORAGE_ACCOUNT_ID!, namespace: this.env.CRUCE_ARTIFACTS_NAMESPACE! };
	}
	/** Called only by explicit resource mutations after the namespace policy gate. */
	bind() {
		const binding = this.binding();
		if (!this.store.get("storage-binding")) this.store.put("storage-binding", binding);
	}
	async host(): Promise<RepositoryHost> {
		const binding = this.binding();
		return new ArtifactsBindingHost(
			this.env.ARTIFACTS!,
			binding.accountId,
			binding.namespace,
			this.resources.namespace,
			this.identities,
			this.send,
		);
	}
}

function providerCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** One deployment binding; stable application namespace IDs isolate physical repo names. */
export class ArtifactsBindingHost implements RepositoryHost {
	constructor(
		private readonly artifacts: Artifacts,
		readonly accountId: string,
		readonly storageNamespace: string,
		readonly namespaceId: string,
		readonly identities: ProviderIdentity,
		private readonly send: Send = fetch,
	) {}
	private physical(name: string) {
		if (!/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-zA-Z0-9_-]+$/.test(this.namespaceId))
			throw new DomainError(400, "Invalid storage identity");
		return `ns-${this.namespaceId}-${name}`;
	}
	private async provider<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof DomainError) throw error;
			const code = providerCode(error);
			diagnose("provider_error", {
				provider: "binding",
				code: code === "NOT_FOUND" || code === "ALREADY_EXISTS" || code === "RATE_LIMITED" ? code : "UNKNOWN",
			});
			if (code === "NOT_FOUND") throw new DomainError(404, "Artifacts repository unavailable");
			if (code === "ALREADY_EXISTS") throw new DomainError(409, "Artifacts repository already exists; retry the same operation");
			throw new DomainError(code === "RATE_LIMITED" ? 429 : 502, "Artifacts operation unavailable; retry the same operation identity");
		}
	}
	private async repository<T>(name: string, run: (repo: ArtifactsRepo, info: ArtifactsRepoInfo) => Promise<T>) {
		using repo = await this.provider(() => this.artifacts.get(this.physical(name)));
		const info = await this.provider(() => repo.info());
		this.validate(name, info);
		return await run(repo, info);
	}
	async info(name: string) {
		return this.repository(name, async (_repo, info) => ({ ...info, name }));
	}
	async verifyFork(name: string, expectedId: string, parentId: string, parentName: string) {
		const parent = await this.info(parentName);
		await this.repository(name, async (_repo, info) => {
			if (
				info.id !== expectedId ||
				parent.id !== parentId ||
				info.source !== `artifacts:${this.storageNamespace}/${this.physical(parentName)}`
			)
				throw new ProviderIdentityError("Fork parent identity changed");
		});
	}

	async withSource<T>(name: string, expectedId: string, run: (source: SourceReader) => Promise<T>) {
		this.identities.require(name);
		return this.repository(name, async (repo, info) => {
			if (info.id !== expectedId) throw new ProviderIdentityError("Artifacts repository identity changed");
			return run({
				readCommit: (oid) => this.provider(() => repo.readCommit(oid)),
				readTree: (oid) => this.provider(() => repo.readTree(oid)),
				readFile: (args) => this.provider(() => repo.readFile({ ...args, ref: providerRef(args.ref) })),
				log: (opts) => this.provider(() => repo.log(opts?.ref ? { ...opts, ref: providerRef(opts.ref) } : opts)),
			});
		});
	}
	private validate(name: string, info: Pick<ArtifactsRepoInfo, "id" | "name" | "remote">) {
		const remote = new URL(info.remote);
		if (
			remote.protocol !== "https:" ||
			remote.hostname !== `${this.accountId}.artifacts.cloudflare.net` ||
			remote.username ||
			remote.password ||
			remote.search ||
			remote.hash ||
			remote.pathname !== `/git/${this.storageNamespace}/${this.physical(name)}.git`
		)
			throw new ProviderIdentityError("Installation storage account mismatch");
		if (info.name !== this.physical(name)) throw new ProviderIdentityError("Artifacts repository address mismatch");
		if (!info.id) throw new ProviderIdentityError("Provider repository identity unavailable");
		this.identities.check(name, info.id);
	}
	private async revokeOutstanding(name: string) {
		await this.repository(name, async (repo) => {
			for (let page = 0; page < 20; page++) {
				const { tokens, total } = await this.provider(() => repo.listTokens());
				if (total > tokens.length) throw new DomainError(503, "Repository token inventory is incomplete; cleanup cannot be confirmed");
				const active = tokens.filter((token) => token.state === "active");
				for (const token of active) await this.provider(() => repo.revokeToken(token.id));
				if (!active.length) return;
			}
			throw new DomainError(503, "Repository token reconciliation needs another retry");
		});
	}
	async ensure(name: string, description: string, defaultBranch = "main"): Promise<RepoRef> {
		let created = false;
		try {
			await this.info(name);
		} catch (error) {
			if (!(error instanceof DomainError) || error.status !== 404) throw error;
			if (this.identities.expected(name)) throw new ProviderIdentityError("Recorded Artifacts repository is missing");
			try {
				const initial = await this.provider(() =>
					this.artifacts.create(this.physical(name), { description, setDefaultBranch: defaultBranch }),
				);
				this.validate(name, initial);
				this.identities.record(name, initial.id);
				await this.repository(name, (repo) => this.provider(() => repo.revokeToken(initial.token)));
				created = true;
			} catch (error) {
				if (!(error instanceof DomainError) || error instanceof ProviderIdentityError || error.status !== 409) throw error;
			}
		}
		const info = await this.info(name);
		if (info.description !== description) throw new DomainError(409, "Artifacts repository ownership mismatch");
		this.identities.require(name);
		this.identities.record(name, info.id);
		await this.revokeOutstanding(name);
		return { name, id: info.id, remote: info.remote, created };
	}
	async fork(source: string, target: string, description: string): Promise<RepoRef> {
		this.identities.require(source);
		await this.info(source);
		let created = false;
		try {
			await this.info(target);
		} catch (error) {
			if (!(error instanceof DomainError) || error.status !== 404) throw error;
			if (this.identities.expected(target)) throw new ProviderIdentityError("Recorded Artifacts repository is missing");
			try {
				const initial = await this.repository(source, (repo) =>
					this.provider(() => repo.fork(this.physical(target), { description, defaultBranchOnly: true, readOnly: false })),
				);
				this.validate(target, initial);
				this.identities.record(target, initial.id);
				await this.repository(target, (repo) => this.provider(() => repo.revokeToken(initial.token)));
				created = true;
			} catch (error) {
				if (!(error instanceof DomainError) || error instanceof ProviderIdentityError || error.status !== 409) throw error;
			}
		}
		const info = await this.info(target);
		if (info.description !== description || info.source !== `artifacts:${this.storageNamespace}/${this.physical(source)}`)
			throw new DomainError(409, "Fork ownership or parent mismatch");
		this.identities.require(target);
		this.identities.record(target, info.id);
		await this.revokeOutstanding(target);
		return { name: target, id: info.id, remote: info.remote, created };
	}
	async remove(name: string, expectedId?: string) {
		try {
			const info = await this.info(name);
			if (!expectedId || info.id !== expectedId) throw new ProviderIdentityError("Artifacts repository identity changed");
			await this.provider(() => this.artifacts.delete(this.physical(name)));
			return false;
		} catch (error) {
			if (error instanceof DomainError && error.status === 404) return true;
			throw error;
		}
	}
	async withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>) {
		this.identities.require(name);
		return this.repository(name, async (repo) => {
			const token = await this.provider(() => repo.createToken(scope, 60));
			try {
				return { result: await fn(token.plaintext), tokenId: token.id };
			} finally {
				await this.provider(() => repo.revokeToken(token.id));
			}
		});
	}
	gitRequest(name: string, request: Request, expectedId?: string) {
		return forwardGit(this, this.accountId, this.send, name, request, expectedId);
	}
}

/** Bounded transfer, including chunked requests. This is a Cruce limit, not an Artifacts repository limit. */
export async function boundedBody(
	message: Request | Response,
	limit: number = TRANSFER_LIMITS.gitBytes,
	reason = "Git transfer exceeds the 32 MiB gateway limit",
): Promise<ArrayBuffer> {
	const length = message.headers.get("content-length");
	if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
		await message.body?.cancel();
		throw new DomainError(413, reason);
	}
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
			throw new DomainError(413, reason);
		}
		// Do not retain an oversized backing buffer supplied as a small view.
		chunks.push(value.slice());
	}
	if (chunks.length === 1) return chunks[0].buffer as ArrayBuffer;
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes.buffer;
}
