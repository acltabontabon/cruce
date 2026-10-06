import { vi } from "vitest";
import type { StorageEnv } from "../../src/worker/artifacts.ts";
import { memoryStore, type Store } from "../../src/worker/store.ts";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export function memory() {
	const data = new Map<string, unknown>();
	const store: Store = {
		...memoryStore(data),
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
export function provider() {
	const infos = new Map<string, ArtifactsRepoInfo>();
	const tokens = new Map<string, ArtifactsTokenInfo[]>();
	const disposed = vi.fn();
	const readCommit = vi.fn(async (_name: string, _oid: string): Promise<ArtifactsCommitMetadata | null> => null);
	const readTree = vi.fn(async (_name: string, _oid: string): Promise<ArtifactsTreeEntry[] | null> => null);
	const readFile = vi.fn(async (_name: string, _args: { ref: string; path: string }): Promise<Blob | null> => null);
	const log = vi.fn(
		async (_name: string, _opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]> => [],
	);
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
			readCommit: async (oid: string) => {
				active();
				return readCommit(name, oid);
			},
			readTree: async (oid: string) => {
				active();
				return readTree(name, oid);
			},
			readFile: async (args: { ref: string; path: string }) => {
				active();
				return readFile(name, args);
			},
			log: async (opts?: { ref?: string; limit?: number; offset?: number }) => {
				active();
				return log(name, opts);
			},
		} as unknown as ArtifactsRepo;
	});
	const remove = vi.fn(async (_name: string) => true);
	const artifacts = { create, get, delete: remove } as unknown as Artifacts;
	const env: StorageEnv = { ARTIFACTS: artifacts, CRUCE_STORAGE_ACCOUNT_ID: ACCOUNT, CRUCE_ARTIFACTS_NAMESPACE: "cruce" };
	return {
		artifacts,
		env,
		infos,
		tokens,
		create,
		get,
		fork,
		remove,
		revokeToken,
		createToken,
		disposed,
		readCommit,
		readTree,
		readFile,
		log,
	};
}
