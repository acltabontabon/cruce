import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { initialNamespace, NamespaceController } from "../src/core/ownership.ts";
import { RepositoryController } from "../src/core/platform.ts";
import { STATE_LIMITS, TRANSFER_LIMITS } from "../src/shared/limits.ts";
import type { Actor, Command, Repository, Workspace } from "../src/shared/platform.ts";
import { boundedBody } from "../src/worker/artifacts.ts";
import { MemoryFs } from "../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../src/worker/git/workspace.ts";
import { RepositoryRuntime } from "../src/worker/repository-runtime.ts";
import { jsonBytes, sqlStore } from "../src/worker/store.ts";

// Local SQLite/Node measurement only. No provider, network or live authorization.
const db = new DatabaseSync(":memory:");
let statements = 0;
const sql = {
	exec: (query: string, ...args: (string | number | null)[]) => {
		statements++;
		const statement = db.prepare(query);
		const rows = query.startsWith("SELECT ") ? statement.all(...args) : [];
		if (!query.startsWith("SELECT ")) statement.run(...args);
		return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
	},
} as unknown as SqlStorage;
const atomic = <T>(run: () => T) => {
	db.exec("SAVEPOINT measurement");
	try {
		const result = run();
		db.exec("RELEASE measurement");
		return result;
	} catch (error) {
		db.exec("ROLLBACK TO measurement");
		db.exec("RELEASE measurement");
		throw error;
	}
};
const store = sqlStore(sql, atomic);
const actor: Actor = { id: "measurement-owner", userId: "measurement-owner", name: "Measurement", kind: "human" };
const repository: Repository = {
	id: "measurement",
	namespaceId: "namespace",
	name: "measurement",
	defaultBranch: "main",
	createdAt: 1000,
	storageName: "unused",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const namespace = new NamespaceController(
	initialNamespace({ id: "namespace", name: "Measurement", handle: "measurement", kind: "personal", ownerId: actor.id, createdAt: 1000 }),
	1000,
);
namespace.repository(namespace.authority(actor), repository);
const port = {
	authority: () => namespace.authority(actor, repository.id),
	repository: () => repository,
	reserve: () => {
		throw new Error("Measurement must not reserve resources");
	},
	settle: () => {},
	resourceConfiguration: () => {
		throw new Error("Measurement must not access source storage");
	},
};
let now = 1000;
const runtime = new RepositoryRuntime(store, new GitWorkspace(new MemoryFs() as never), port, {}, () => now);
runtime.initialize(repository);
const c = new RepositoryController(runtime.state(), now, () => "workspace");
const workspace = c.command({ tool: "start_workspace", title: "Measurement", baseRevision: "a".repeat(40) }, port.authority()) as Workspace;
const execution = { id: "execution", checkoutId: "checkout", machineId: "machine", kind: "worktree" as const, owned: true };
c.command({ tool: "attach_workspace", workspaceId: workspace.id, execution }, port.authority());
runtime.save(c);
const originalLog = console.log;
console.log = () => {};
const started = performance.now();
let maxStatements = 0;
for (let n = 0; n < 10_000; n++) {
	now++;
	const before = statements;
	const cmd: Command = {
		tool: "report_change",
		namespaceId: repository.namespaceId,
		repositoryId: repository.id,
		workspaceId: workspace.id,
		execution,
		revision: "a".repeat(40),
		changes: [{ path: `src/file-${n % 2}.ts`, status: "modified" }],
		idempotencyKey: `measurement-${n}`,
	};
	await runtime.command(cmd, { actor });
	maxStatements = Math.max(maxStatements, statements - before);
}
console.log = originalLog;
const runtimeMs = Math.round(performance.now() - started);
const snapshot = await runtime.command(
	{ tool: "get_repository", namespaceId: repository.namespaceId, repositoryId: repository.id },
	{ actor },
);
const plan = db
	.prepare("EXPLAIN QUERY PLAN SELECT key, body FROM records WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
	.all("activity:", "activity;", "activity:0000000000009900", 100);
const bytes = TRANSFER_LIMITS.gitBytes;
const transferStarted = performance.now();
let remaining = bytes;
const body = new ReadableStream<Uint8Array>({
	pull(controller) {
		if (!remaining) {
			controller.close();
			return;
		}
		const chunk = Math.min(64 * 1024, remaining);
		remaining -= chunk;
		controller.enqueue(new Uint8Array(chunk));
	},
});
const transfer = await boundedBody(new Response(body));
const result = {
	environment: "Local Node SQLite; synthetic reports; no cloud requests. Timings/RSS are not Worker acceptance.",
	commands: 10_000,
	retainedReceipts: 10_000,
	retainedActivity: 10_002,
	runtimeMs,
	maxSqlStatementsPerReport: maxStatements,
	hotStateBytes: jsonBytes(runtime.state()),
	snapshotBytes: jsonBytes(snapshot),
	...store.usage(),
	pageQueryPlan: plan,
	gatewayBytes: transfer.byteLength,
	gatewayBufferMs: Math.round(performance.now() - transferStarted),
	nodeRssBytes: process.memoryUsage().rss,
	limits: STATE_LIMITS,
};
if (
	transfer.byteLength !== bytes ||
	runtime.state().activity.length !== STATE_LIMITS.recentActivity ||
	Object.keys(runtime.state().receipts).length
)
	throw new Error("Bounded storage measurement failed");
await mkdir("dist/state-verification", { recursive: true });
await writeFile("dist/state-verification/measurements.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
db.close();
