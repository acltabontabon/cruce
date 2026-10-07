import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATE_LIMITS } from "../../src/shared/limits.ts";
import { cleanupTokenGrant, continuationGrant } from "../../src/worker/continuation.ts";
import { Directory } from "../../src/worker/directory.ts";
import { NamespaceRuntime } from "../../src/worker/namespace-runtime.ts";
import { hash, sqlStore } from "../../src/worker/store.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: unknown,
		) {}
	},
}));
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	vi.restoreAllMocks();
});
function database() {
	const db = new DatabaseSync(":memory:");
	closers.push(() => db.close());
	const queries: string[] = [];
	const sql = {
		exec: (query: string, ...args: (string | number | null)[]) => {
			queries.push(query);
			const statement = db.prepare(query);
			const rows = query.startsWith("SELECT ") ? statement.all(...args) : [];
			if (!query.startsWith("SELECT ")) statement.run(...args);
			return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
		},
	} as unknown as SqlStorage;
	const transactionSync = <T>(run: () => T) => {
		db.exec("SAVEPOINT atomic");
		try {
			const result = run();
			db.exec("RELEASE atomic");
			return result;
		} catch (error) {
			db.exec("ROLLBACK TO atomic");
			db.exec("RELEASE atomic");
			throw error;
		}
	};
	const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
	return { db, queries, sql, ctx, store: sqlStore(sql, transactionSync) };
}
describe("bounded indexed coordination storage", () => {
	it("keeps cold scans and usage pure, and counts UTF-8 bytes with atomic rollback", () => {
		const f = database();
		expect(f.store.usage()).toEqual({ bytes: 0, records: 0 });
		expect(f.store.scan("receipt:")).toEqual([]);
		expect(f.queries.every((query) => query.startsWith("SELECT "))).toBe(true);
		f.store.put("a", { text: "日本語" });
		const before = f.store.usage();
		expect(before.bytes).toBe(new TextEncoder().encode('a{"text":"日本語"}').length);
		expect(() =>
			f.store.batch([
				{ key: "small", value: true },
				{ key: "large", value: "x".repeat(STATE_LIMITS.recordBytes) },
			]),
		).toThrow("byte limit");
		expect(f.store.get("small")).toBeUndefined();
		expect(f.store.usage()).toEqual(before);
		f.db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON records WHEN NEW.key = 'fail' BEGIN SELECT RAISE(ABORT, 'fault'); END");
		expect(() =>
			f.store.batch([
				{ key: "first", value: true },
				{ key: "fail", value: true },
			]),
		).toThrow("fault");
		expect(f.store.get("first")).toBeUndefined();
		expect(f.store.usage()).toEqual(before);
		f.store.delete("a");
		expect(f.store.usage()).toEqual({ bytes: 0, records: 0 });
	});
	it("pages 10,000 retained records with indexed scans, without deleting identities or scanning usage", () => {
		const f = database();
		for (let n = 0; n < 10_000; n++) f.store.put(`receipt:${String(n).padStart(8, "0")}`, { fingerprint: `hash-${n}`, result: { id: n } });
		f.queries.length = 0;
		let after: string | undefined,
			count = 0;
		for (;;) {
			const rows = f.store.scan<{ result: { id: number } }>("receipt:", after);
			if (!rows.length) break;
			count += rows.length;
			after = rows.at(-1)!.key;
		}
		expect(count).toBe(10_000);
		expect(f.store.get("receipt:00000000")).toEqual({ fingerprint: "hash-0", result: { id: 0 } });
		expect(f.store.usage().records).toBe(10_000);
		expect(f.queries.some((query) => query.includes("sum("))).toBe(false);
		const plan = f.db
			.prepare("EXPLAIN QUERY PLAN SELECT key, body FROM records WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
			.all("receipt:", "receipt;", "receipt:00009900", 100);
		expect(JSON.stringify(plan)).toContain("INDEX");
	});
	it("reserves storage headroom for existing operations while rejecting new admissions", () => {
		const f = database();
		f.store.put("existing", { phase: "pending" });
		f.db.prepare("UPDATE record_usage SET bytes = ? WHERE id = 1").run(STATE_LIMITS.storeBytes - STATE_LIMITS.recoveryBytes - 10);
		expect(() => f.store.admit(11)).toThrow("capacity reached");
		f.store.put("existing", { phase: "complete" });
		expect(f.store.get("existing")).toEqual({ phase: "complete" });
	});
	it("indexes Directory identity and candidate lookup and preserves IDs on explicit sign-in conversion", () => {
		const f = database();
		const namespace = { id: "personal", ownerId: "owner", handle: "owner", name: "Owner", kind: "personal", createdAt: 1 };
		const user = {
			id: "owner",
			issuer: "issuer",
			subject: "subject",
			email: "owner@local",
			name: "Owner",
			personalNamespaceId: "personal",
		};
		f.store.put("directory", { users: [user], namespaces: [namespace] });
		let directory = new Directory(f.ctx, {} as never);
		const before = f.store.usage();
		expect(directory.resolve({ tenantId: "issuer", developerId: "subject" })).toEqual(user);
		expect(f.store.usage()).toEqual(before);
		directory.login({ tenantId: "issuer", developerId: "subject", email: "current@local" });
		directory = new Directory(f.ctx, {} as never);
		expect(f.store.get("directory")).toBeUndefined();
		expect(directory.resolve({ tenantId: "issuer", developerId: "subject" })).toMatchObject({ id: "owner", email: "current@local" });
		expect(directory.namespaces("owner")).toEqual([namespace]);
		f.queries.length = 0;
		directory.resolve({ tenantId: "issuer", developerId: "subject" });
		expect(f.queries.filter((query) => query.includes("FROM records"))).toHaveLength(2);
		expect(() => directory.resolve({ tenantId: "issuer", developerId: "unknown" })).toThrow("Sign in");
	});
	it("keeps namespace charges atomic across concurrent reservations, UTC days and restarts", async () => {
		const f = database(),
			now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const env = { CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32), CRUCE_ARTIFACTS_NAMESPACE: "cruce", ARTIFACTS: {} };
		let namespace = new NamespaceRuntime(f.ctx, env as never);
		const actor = { id: "owner", userId: "owner", name: "Owner", kind: "human" as const },
			grant = { actor };
		namespace.initialize({ id: "namespace", handle: "team", name: "Team", ownerId: "owner", kind: "shared", createdAt: 1 });
		namespace.saveRepository(grant, {
			id: "repo",
			namespaceId: "namespace",
			name: "repo",
			defaultBranch: "main",
			createdAt: 1,
			storageName: "repo",
			grants: [],
			policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
		});
		namespace.policy(grant, { ...namespace.snapshot(grant).policy, dailyLimit: 1 });
		const results = await Promise.allSettled([
			namespace.reserve(grant, "repo", "one", "input", "workspace.fork"),
			namespace.reserve(grant, "repo", "two", "input", "workspace.fork"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const operationId = ["one", "two"][results.findIndex((result) => result.status === "fulfilled")];
		expect(namespace.snapshot(grant).budget.used).toBe(1);
		now.mockReturnValue(86400000 + 1000);
		namespace = new NamespaceRuntime(f.ctx, env as never);
		const replay = await namespace.reserve(grant, "repo", operationId, "input", "workspace.fork");
		expect(replay.at).toBe(1000);
		expect(namespace.snapshot(grant).budget.used).toBe(0);
		await expect(namespace.reserve(grant, "repo", operationId, "changed", "workspace.fork")).rejects.toThrow("identity reused");
		namespace.settle(replay.id, "uncertain");
		expect(() => namespace.settle(replay.id, "released")).toThrow("cannot be released");
		expect(f.store.get<{ reservations: unknown[] }>("namespace")!.reservations).toEqual([]);
		expect(namespace.reservations(grant).items[0].state).toBe("uncertain");
	});
});
describe("durable cleanup connection authority", () => {
	it("intersects current scopes and rejects revoked, expired or changed OAuth repository approval", async () => {
		const record = { encryptedProps: "sealed-approved-repositories", scope: ["cruce:read", "workspace:write"], expiresAt: 100 };
		const get = vi.fn(async () => record),
			kv = { get } as unknown as KVNamespace;
		const grant = {
			actor: { id: "agent", userId: "owner", name: "Client", kind: "agent" as const },
			scopes: ["cruce:read", "workspace:write", "revision:publish"],
			repositories: ["repo"],
			continuation: { kind: "oauth" as const, key: "grant:user:id", propsHash: await hash(record.encryptedProps) },
		};
		expect((await continuationGrant(grant, kv, 1000)).scopes).toEqual(["cruce:read", "workspace:write"]);
		record.encryptedProps = "changed-approved-repositories";
		await expect(continuationGrant(grant, kv, 1000)).rejects.toThrow("authorization unavailable");
		record.encryptedProps = "sealed-approved-repositories";
		await expect(continuationGrant(grant, kv, 100_000)).rejects.toThrow("authorization unavailable");
		get.mockResolvedValueOnce(null as never);
		await expect(continuationGrant(grant, kv, 1000)).rejects.toThrow("authorization unavailable");
	});
});

describe("bounded gateway bodies (F6)", () => {
	it("rejects declared oversize bodies before reading and cancels chunked overflow", async () => {
		const { boundedBody } = await import("../../src/worker/artifacts.ts");
		const cancel = vi.fn(),
			getReader = vi.fn();
		await expect(
			boundedBody({ headers: new Headers({ "content-length": "11" }), body: { cancel, getReader } } as unknown as Response, 10),
		).rejects.toMatchObject({ status: 413 });
		expect(cancel).toHaveBeenCalled();
		expect(getReader).not.toHaveBeenCalled();
		let delivered = 0;
		const chunked = new ReadableStream<Uint8Array>({
			pull(controller) {
				delivered++;
				controller.enqueue(new Uint8Array(4));
			},
			cancel,
		});
		await expect(boundedBody(new Response(chunked), 10)).rejects.toMatchObject({ status: 413 });
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(delivered).toBeLessThanOrEqual(4);
	});
	it("accepts the exact byte ceiling and owns only the bytes in a buffer view", async () => {
		const { boundedBody } = await import("../../src/worker/artifacts.ts");
		const backing = new Uint8Array(10000);
		backing.fill(7);
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(backing.subarray(0, 10));
					controller.close();
				},
			}),
		);
		const body = await boundedBody(response, 10);
		expect(body.byteLength).toBe(10);
		backing.fill(1);
		expect([...new Uint8Array(body)]).toEqual(Array(10).fill(7));
	});
});

describe("cleanup submission proof", () => {
	it("binds the token's original repository approval instead of adopting a changed current grant", async () => {
		const token = "subject:grant:private-secret";
		let approval = "original-encrypted-approval";
		const keys: string[] = [];
		const kv = {
			get: async (key: string) => {
				keys.push(key);
				return key.startsWith("token:")
					? { grant: { encryptedProps: "original-encrypted-approval" } }
					: { encryptedProps: approval, scope: ["cruce:read", "workspace:write"] };
			},
		} as unknown as KVNamespace;
		const grant = {
			actor: { id: "agent", userId: "owner", kind: "agent" as const, name: "Client" },
			scopes: ["cruce:read", "workspace:write"],
			repositories: ["original-repository"],
		};
		const captured = await cleanupTokenGrant(grant, token, kv);
		expect(captured.repositories).toEqual(["original-repository"]);
		expect(captured.continuation).toMatchObject({ propsHash: await hash("original-encrypted-approval") });
		expect(keys[0]).toBe(`token:subject:grant:${await hash(token)}`);
		expect(JSON.stringify(captured)).not.toContain("private-secret");
		approval = "new-encrypted-repository-approval";
		await expect(cleanupTokenGrant(grant, token, kv)).rejects.toThrow("authorization unavailable");
	});
});

describe("bounded Git metadata before parsing", () => {
	it("rejects a large ref advertisement before constructing its full parsed inventory", async () => {
		const { GitWorkspace } = await import("../../src/worker/git/workspace.ts");
		const { MemoryFs } = await import("../../src/worker/git/memory-fs.ts");
		const pkt = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
		const response =
			pkt("# service=git-upload-pack\n") +
			"0000" +
			Array.from({ length: 4000 }, (_, n) =>
				pkt(`${"a".repeat(40)} refs/heads/branch-${n}${n === 0 ? "\0side-band-64k ofs-delta" : ""}\n`),
			).join("") +
			"0000";
		const send = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(response, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }));
		const git = new GitWorkspace(new MemoryFs() as never);
		await expect(git.remoteRefs({ url: "https://provider.invalid/repository.git", token: "private" })).rejects.toMatchObject({
			status: 413,
		});
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("existing resource operation retention", () => {
	it("replays an embedded reservation during explicit layout compaction without changing identity or charging again", async () => {
		const f = database();
		const { initialNamespace, NamespaceController } = await import("../../src/core/ownership.ts");
		const actor = { id: "owner", userId: "owner", kind: "human" as const, name: "Owner" },
			grant = { actor };
		const c = new NamespaceController(
			initialNamespace({ id: "namespace", ownerId: "owner", handle: "team", name: "Team", kind: "shared", createdAt: 1 }),
			Date.now(),
		);
		c.repository(c.authority(actor), {
			id: "repo",
			namespaceId: "namespace",
			name: "repo",
			storageName: "repo",
			defaultBranch: "main",
			createdAt: 1,
			grants: [],
			policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
		});
		const previous = c.reserve(c.authority(actor, "repo"), "operation", "original-input", "workspace.cleanup", "workspace");
		f.store.put("namespace", c.state);
		const namespace = new NamespaceRuntime(f.ctx, {
			CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32),
			CRUCE_ARTIFACTS_NAMESPACE: "cruce",
			ARTIFACTS: {},
		} as never);
		expect(namespace.reservations(grant).items).toHaveLength(1);
		const replay = await namespace.reserve(grant, "repo", "operation", "original-input", "workspace.cleanup", "workspace");
		expect(replay.id).toBe(previous.id);
		expect(replay.at).toBe(previous.at);
		expect(namespace.snapshot(grant).budget.used).toBe(1);
		expect(f.store.get<{ reservations: unknown[] }>("namespace")?.reservations).toEqual([]);
		expect(namespace.reservations(grant).items).toHaveLength(1);
	});
});
