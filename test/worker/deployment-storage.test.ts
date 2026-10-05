import { describe, expect, it, vi } from "vitest";
import { ArtifactsBindingHost, ResourceBoundary, type StorageEnv } from "../../src/worker/artifacts.ts";
import type { Store } from "../../src/worker/store.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
function memory() {
	const data = new Map<string, unknown>();
	const store: Store = {
		get: <T>(key: string) => data.get(key) as T | undefined,
		put: vi.fn((key, value) => {
			data.set(key, value);
		}),
		delete: vi.fn((key) => {
			data.delete(key);
		}),
	};
	return { store, data };
}
function provider() {
	const infos = new Map<string, ArtifactsRepoInfo>();
	const tokens = new Map<string, ArtifactsTokenInfo[]>();
	const disposed = vi.fn();
	const missing = () => Object.assign(new Error("private provider detail"), { code: "NOT_FOUND" });
	const create = vi.fn(async (name: string, opts?: { description?: string; setDefaultBranch?: string }) => {
		const info = {
			id: `id-${name}`,
			name,
			description: opts?.description ?? null,
			defaultBranch: opts?.setDefaultBranch ?? "main",
			remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/cruce/${name}.git`,
			source: null,
		} as ArtifactsRepoInfo;
		infos.set(name, info);
		tokens.set(name, [{ id: "creation", state: "active" } as ArtifactsTokenInfo]);
		return { ...info, token: "creation-secret" };
	});
	const revokeToken = vi.fn(async (name: string, id: string) => {
		if (id === "creation-secret") id = "creation";
		tokens.set(
			name,
			(tokens.get(name) ?? []).filter((token) => token.id !== id),
		);
		return true;
	});
	const createToken = vi.fn(async (name: string, scope: string, ttl: number) => {
		tokens.set(name, [...(tokens.get(name) ?? []), { id: "short", state: "active" } as ArtifactsTokenInfo]);
		return { id: "short", plaintext: "provider-secret", scope, ttl };
	});
	const fork = vi.fn(async (source: string, name: string, opts: { description: string }) => {
		const created = await create(name, opts);
		infos.get(name)!.source = `artifacts:cruce/${source}`;
		return created;
	});
	const get = vi.fn(async (name: string) => {
		if (!infos.has(name)) throw missing();
		let closed = false;
		const active = () => {
			if (closed) throw new Error("Handle disposed before operation completed");
		};
		return {
			[Symbol.dispose]: () => {
				closed = true;
				disposed(name);
			},
			info: async () => {
				active();
				return infos.get(name)!;
			},
			listTokens: async () => {
				active();
				return { tokens: tokens.get(name) ?? [], total: tokens.get(name)?.length ?? 0 };
			},
			revokeToken: async (id: string) => {
				active();
				return revokeToken(name, id);
			},
			createToken: async (scope: string, ttl: number) => {
				active();
				return createToken(name, scope, ttl);
			},
			fork: async (target: string, opts: { description: string }) => {
				active();
				return fork(name, target, opts);
			},
		} as unknown as ArtifactsRepo;
	});
	const remove = vi.fn(async (_name: string) => true);
	const artifacts = { create, get, delete: remove } as unknown as Artifacts;
	const env: StorageEnv = { ARTIFACTS: artifacts, CRUCE_STORAGE_ACCOUNT_ID: ACCOUNT, CRUCE_ARTIFACTS_NAMESPACE: "cruce" };
	return { artifacts, env, infos, tokens, create, get, fork, remove, revokeToken, createToken, disposed };
}

describe("deployment resource boundary", () => {
	it("inherits configured storage without credentials, provider calls or writes on reads", async () => {
		const p = provider(),
			{ store } = memory();
		const boundary = new ResourceBoundary(store, p.env, { namespace: "team" });
		expect(boundary.storage()).toEqual({ mode: "deployment", ready: true });
		expect(await boundary.host()).toBeInstanceOf(ArtifactsBindingHost);
		expect(store.put).not.toHaveBeenCalled();
		expect(p.get).not.toHaveBeenCalled();
		expect(JSON.stringify(boundary.storage())).not.toContain(ACCOUNT);
	});
	it("pins storage on the explicit resource operation and refuses later account or namespace changes", async () => {
		const p = provider(),
			{ store } = memory();
		const boundary = new ResourceBoundary(store, p.env, { namespace: "team" });
		boundary.bind();
		boundary.bind();
		expect(store.put).toHaveBeenCalledTimes(1);
		for (const env of [
			{ ...p.env, CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32) },
			{ ...p.env, CRUCE_ARTIFACTS_NAMESPACE: "other" },
		]) {
			const changed = new ResourceBoundary(store, env, { namespace: "team" });
			await expect(changed.host()).rejects.toThrow("identity changed");
			expect(() => changed.bind()).toThrow("identity changed");
		}
		expect(boundary.storage().ready).toBe(true);
		expect(p.get).not.toHaveBeenCalled();
	});
	it("refuses legacy storage without deleting its credentials or moving retained source", async () => {
		const p = provider(),
			{ store, data } = memory();
		data.set("resource-account", { sealed: "legacy-secret" });
		const boundary = new ResourceBoundary(store, p.env, { namespace: "team" });
		await expect(boundary.host()).rejects.toThrow("explicit storage transition");
		expect(store.delete).not.toHaveBeenCalled();
		expect(p.create).not.toHaveBeenCalled();
		expect(data.get("resource-account")).toEqual({ sealed: "legacy-secret" });
	});
	it.each([{}, { CRUCE_STORAGE_ACCOUNT_ID: ACCOUNT, CRUCE_ARTIFACTS_NAMESPACE: "cruce" }])(
		"fails closed when deployment storage is incomplete",
		async (env) => {
			const { store } = memory();
			const boundary = new ResourceBoundary(store, env, { namespace: "team" });
			await expect(boundary.host()).rejects.toMatchObject({ status: 409 });
			expect(() => boundary.bind()).toThrow("administrator");
			expect(store.put).not.toHaveBeenCalled();
		},
	);
});

describe("Artifacts binding host", () => {
	it("isolates identical logical names across application namespaces and revokes creation tokens", async () => {
		const p = provider();
		for (const ns of ["team-a", "team-b"]) {
			const host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", ns);
			expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ name: "repo", created: true });
			expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ created: false });
			expect(p.tokens.get(`ns-${ns}-repo`)).toEqual([]);
		}
		expect(p.create.mock.calls.map(([name]) => name)).toEqual(["ns-team-a-repo", "ns-team-b-repo"]);
		expect(p.create.mock.calls[0][1]?.setDefaultBranch).toBe("trunk");
	});
	it("cleans up a creation token after a lost revocation response on retry", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team");
		p.revokeToken.mockRejectedValueOnce(new Error("response lost"));
		await expect(host.ensure("repo", "owned")).rejects.toThrow("retry");
		expect(p.tokens.get("ns-team-repo")).toHaveLength(1);
		expect(await host.ensure("repo", "owned")).toMatchObject({ created: false });
		expect(p.create).toHaveBeenCalledTimes(1);
		expect(p.tokens.get("ns-team-repo")).toEqual([]);
	});
	it("validates fork ownership and parent on creation and replay", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team");
		await host.ensure("repo", "owned");
		expect(await host.fork("repo", "fork", "workspace")).toMatchObject({ name: "fork", created: true });
		expect(await host.fork("repo", "fork", "workspace")).toMatchObject({ created: false });
		p.infos.get("ns-team-fork")!.source = "artifacts:cruce/unrelated";
		await expect(host.fork("repo", "fork", "workspace")).rejects.toThrow("parent mismatch");
		await expect(host.ensure("repo", "other owner")).rejects.toThrow("ownership mismatch");
	});
	it("mints 60-second tokens and revokes them even when Git fails, within the handle lifetime", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team");
		await host.ensure("repo", "owned");
		await expect(
			host.withToken("repo", "write", async (token) => {
				expect(token).toBe("provider-secret");
				await Promise.resolve();
				throw new Error("Git failed");
			}),
		).rejects.toThrow("Git failed");
		expect(p.createToken).toHaveBeenCalledWith("ns-team-repo", "write", 60);
		expect(p.revokeToken).toHaveBeenCalledWith("ns-team-repo", "short");
		expect(p.tokens.get("ns-team-repo")).toEqual([]);
		expect(p.disposed).toHaveBeenCalled();
	});
	it("rejects account and provider ID mismatches before minting tokens or deleting source", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team");
		await host.ensure("repo", "owned");
		await expect(
			host.gitRequest("repo", new Request("https://cruce.test/info/refs?service=git-upload-pack"), "replacement"),
		).rejects.toThrow("identity changed");
		await expect(host.remove("repo", "replacement")).rejects.toThrow("identity changed");
		p.infos.get("ns-team-repo")!.remote = "https://attacker.invalid/repo.git";
		await expect(host.info("repo")).rejects.toThrow("account mismatch");
		expect(p.createToken).not.toHaveBeenCalled();
		expect(p.remove).not.toHaveBeenCalled();
	});
	it("waits for confirmed absence after asynchronous deletion", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team");
		const repo = await host.ensure("repo", "owned");
		expect(await host.remove("repo", repo.id)).toBe(false);
		p.infos.delete("ns-team-repo");
		expect(await host.remove("repo", repo.id)).toBe(true);
		expect(p.remove).toHaveBeenCalledTimes(1);
	});
});
