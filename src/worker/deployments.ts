import { CoordinationError } from "../core/workstreams.ts";
import type { ResourceAccount, SmokeCheck } from "../shared/platform.ts";
import type { ArtifactsHost, RepoRef } from "./artifacts-host.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import { type SealingEnv, seal, unseal } from "./sealing.ts";
import type { TowerStore } from "./tower.ts";

/**
 * The resource boundary. Cruce's control plane keeps intent, missions, proposals, policy and lineage;
 * the project's Cloudflare account owns (and pays for) the Artifacts deploy repository, Workers Builds
 * and the deployed Worker. Cruce orchestrates across that boundary only through policy-checked actions.
 *
 * Operator mode: Cruce is deployed in the same account (self-hosted); Artifacts is reached through the
 * Worker binding. Connected mode: another account; Artifacts is reached through its REST API with the
 * connected account's API token. Workers Builds always uses the API token, sealed at rest and never returned.
 */

export interface RepositoryHost {
	ensure(name: string, description: string): Promise<RepoRef>;
	info(name: string): Promise<{ name: string; description?: string | null; remote: string }>;
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
		throw new CoordinationError(
			response.status === 404 ? 404 : 502,
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
	async ensure(name: string, description: string): Promise<RepoRef> {
		try {
			const info = await this.info(name);
			return { name: info.name, id: info.id, remote: info.remote, created: false };
		} catch (error) {
			if ((error as CoordinationError).status !== 404) throw error;
		}
		const created = await cloudflare<{ id: string; name: string; remote: string; token: string }>(
			this.send,
			this.token,
			this.path("/repos"),
			{
				method: "POST",
				body: JSON.stringify({ name, description, default_branch: "main" }),
			},
		);
		// The creation token is long-lived; Cruce never keeps it.
		const tokens = await cloudflare<{ id: string; plaintext?: string }[]>(this.send, this.token, this.path(`/repos/${name}/tokens`)).catch(
			() => [],
		);
		for (const t of tokens) await this.revoke(t.id);
		return { name: created.name, id: created.id, remote: created.remote, created: true };
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
		await cloudflare(this.send, this.token, this.path(`/tokens/${id}`), { method: "DELETE" }).catch(() => undefined);
	}
}

export interface BuildRecord {
	build_uuid: string;
	status: "queued" | "initializing" | "running" | "stopped";
	build_outcome?: "success" | "fail" | "skipped" | "cancelled" | "terminated" | null;
	preview_url?: string | null;
	build_trigger_metadata?: { branch?: string; commit_hash?: string };
}
/** The few Workers Builds reads Cruce needs to tie a build and its preview URL to an exact revision. */
export class WorkersBuildsClient {
	constructor(
		readonly accountId: string,
		private readonly token: string,
		private readonly send: Send = fetch,
	) {}
	async scriptTag(workerName: string): Promise<string | undefined> {
		const scripts = await cloudflare<{ id: string; tag: string }[]>(this.send, this.token, `/accounts/${this.accountId}/workers/scripts`);
		return scripts.find((s) => s.id === workerName)?.tag;
	}
	async buildFor(scriptTag: string, revision: string, branch: string): Promise<BuildRecord | undefined> {
		const builds = await cloudflare<BuildRecord[]>(
			this.send,
			this.token,
			`/accounts/${this.accountId}/builds/workers/${scriptTag}/builds?per_page=50`,
		);
		return builds.find((b) => b.build_trigger_metadata?.commit_hash === revision && b.build_trigger_metadata?.branch === branch);
	}
	async verify(): Promise<void> {
		await cloudflare(this.send, this.token, `/accounts/${this.accountId}/builds/account/limits`);
	}
}

interface StoredAccount extends ResourceAccount {
	sealed?: string;
}
export interface OperatorResources {
	accountId?: string;
	namespace: string;
	host?: ArtifactsHost;
}

export class ResourceBoundary {
	constructor(
		readonly store: TowerStore,
		readonly env: SealingEnv,
		readonly operator: OperatorResources,
		readonly send: Send = fetch,
	) {}
	/** Public view: never includes the credential. */
	account(): ResourceAccount | undefined {
		const stored = this.store.get<StoredAccount>("resource-account");
		if (stored) {
			const { sealed: _secret, ...view } = stored;
			return view;
		}
		if (!this.operator.host || !this.operator.accountId) return undefined;
		return {
			mode: "operator",
			accountId: this.operator.accountId,
			label: "Cruce deployment account",
			credential: "none",
			capabilities: ["artifacts"],
		};
	}
	async connect(input: { accountId: string; token: string; label?: string }, actor: string): Promise<ResourceAccount> {
		if (!/^[0-9a-f]{32}$/.test(input.accountId)) throw new CoordinationError(400, "Cloudflare account ID required");
		if (input.token.length < 20 || input.token.length > 400) throw new CoordinationError(400, "Cloudflare API token required");
		await new WorkersBuildsClient(input.accountId, input.token, this.send).verify().catch((error) => {
			throw new CoordinationError(400, `Token cannot read Workers Builds for this account: ${(error as Error).message}`);
		});
		const mode = input.accountId === this.operator.accountId && this.operator.host ? "operator" : "connected";
		const account: StoredAccount = {
			mode,
			accountId: input.accountId,
			label: input.label?.slice(0, 80) || (mode === "operator" ? "Cruce deployment account" : "Connected Cloudflare account"),
			credential: "stored",
			capabilities: ["artifacts", "builds"],
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
		if (!stored?.sealed) throw new CoordinationError(409, "Connect a Cloudflare account with a Workers Builds token first");
		return (await unseal<{ token: string }>(this.env, stored.sealed)).token;
	}
	async builds(): Promise<WorkersBuildsClient> {
		const account = this.account();
		if (!account) throw new CoordinationError(409, "No Cloudflare account connected");
		return new WorkersBuildsClient(account.accountId, await this.token(), this.send);
	}
	/** Where deploy repositories live: the account Workers Builds reads from. */
	async host(): Promise<RepositoryHost> {
		const account = this.account();
		if (!account) throw new CoordinationError(409, "No Cloudflare account connected");
		if (account.mode === "operator") {
			if (!this.operator.host) throw new CoordinationError(503, "Artifacts binding unavailable");
			return this.operator.host;
		}
		return new ArtifactsRestHost(account.accountId, this.operator.namespace, await this.token(), this.send);
	}
}

/** Push an exact revision to a deploy repository branch. `main` is production; other branches are previews. */
export async function pushDeployment(git: GitWorkspace, host: RepositoryHost, repository: string, revision: string, branch: string) {
	const info = await host.info(repository);
	const ref = `refs/cruce/deploy/${branch}`;
	await git.setRef(ref, revision);
	// The deploy repository mirrors deployment intent, not history: production may move back for a rollback.
	await host.withToken(repository, "write", (token) =>
		git.push({ url: info.remote, token, localRef: ref, remoteRef: `refs/heads/${branch}`, force: true }),
	);
}

export interface SmokeResult {
	path: string;
	status: number | null;
	expected: number;
	ok: boolean;
	ms: number;
	error?: string;
}
/** Smoke checks Cruce runs itself against a deployed URL: runtime-verified evidence, not agent assertions. */
export async function runSmokeChecks(
	url: string,
	checks: SmokeCheck[],
	send: Send = fetch,
	clock: () => number = Date.now,
): Promise<SmokeResult[]> {
	const origin = new URL(url);
	if (origin.protocol !== "https:") throw new CoordinationError(400, "Smoke checks require an HTTPS preview URL");
	const results: SmokeResult[] = [];
	for (const check of checks) {
		const started = clock();
		try {
			const response = await send(new URL(check.path, origin).toString(), { redirect: "manual", signal: AbortSignal.timeout(10_000) });
			await response.body?.cancel();
			results.push({
				path: check.path,
				status: response.status,
				expected: check.expectStatus,
				ok: response.status === check.expectStatus,
				ms: clock() - started,
			});
		} catch (error) {
			results.push({
				path: check.path,
				status: null,
				expected: check.expectStatus,
				ok: false,
				ms: clock() - started,
				error: (error as Error).message.slice(0, 200),
			});
		}
	}
	return results;
}
