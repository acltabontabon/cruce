import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { initialNamespace, NamespaceController } from "../src/core/ownership.ts";
import { CHANGE_EVENT_INTERVAL, RepositoryController } from "../src/core/platform.ts";
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
// Declared sustained workload: W attached workspaces whose bridges send presence and a report
// every 30 seconds for D days, with the worst-case report churn (the change set differs on every
// report and the head moves every ten minutes).
const WORKSPACES = 10;
const DAYS = Number(process.env.CRUCE_MEASURE_DAYS ?? 1);
const TICK = 30_000;
const TICKS = Math.round((DAYS * 86_400_000) / TICK);
const c = new RepositoryController(runtime.state(), now, () => `setup-${now++}`);
const attached = Array.from({ length: WORKSPACES }, (_, i) => {
	const workspace = c.command(
		{ tool: "start_workspace", title: `Measurement ${i}`, baseRevision: "a".repeat(40) },
		port.authority(),
	) as Workspace;
	const execution = {
		id: `execution-${i}`,
		checkoutId: `checkout-${i}`,
		machineId: `machine-${i}`,
		kind: "worktree" as const,
		owned: true,
	};
	c.command({ tool: "attach_workspace", workspaceId: workspace.id, execution }, port.authority());
	return { workspace, execution };
});
runtime.save(c);
const prefixes = () =>
	Object.fromEntries(
		(
			db.prepare("SELECT substr(key, 1, instr(key || ':', ':')) AS prefix, count(*) AS n FROM records GROUP BY prefix").all() as {
				prefix: string;
				n: number;
			}[]
		).map((row) => [row.prefix, row.n]),
	);
const baseline = { ...store.usage(), prefixes: prefixes() };
const originalLog = console.log;
console.log = () => {};
const started = performance.now();
let maxStatements = 0;
let commands = 0;
let warm: ReturnType<typeof store.usage> & { at: number } = { ...store.usage(), at: now };
const warmTick = Math.min(TICKS - 1, 3600_000 / TICK);
for (let tick = 0; tick < TICKS; tick++) {
	if (tick === warmTick) warm = { ...store.usage(), at: now };
	for (const [i, { workspace, execution }] of attached.entries()) {
		now = 1000 + tick * TICK + i;
		const common = { namespaceId: repository.namespaceId, repositoryId: repository.id, workspaceId: workspace.id, execution };
		for (const cmd of [
			{ ...common, tool: "heartbeat", idempotencyKey: `beat-${i}-${tick}` },
			{
				...common,
				tool: "report_change",
				revision: (Math.floor(tick / 20) % 16).toString(16).repeat(40),
				changes: [{ path: `src/file-${tick % 2}.ts`, status: "modified" }],
				idempotencyKey: `report-${i}-${tick}`,
			},
		] as Command[]) {
			const before = statements;
			await runtime.command(cmd, { actor });
			maxStatements = Math.max(maxStatements, statements - before);
			commands++;
		}
	}
}
console.log = originalLog;
const runtimeMs = Math.round(performance.now() - started);
const snapshot = await runtime.command(
	{ tool: "get_repository", namespaceId: repository.namespaceId, repositoryId: repository.id },
	{ actor },
);
const plan = db
	.prepare("EXPLAIN QUERY PLAN SELECT key, body FROM records WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
	.all("activity:", "activity;", "activity:0000000000000100", 100);
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
const final = { ...store.usage(), prefixes: prefixes() };
const elapsedDays = (now - warm.at) / 86_400_000;
const recordsPerDay = (final.records - warm.records) / elapsedDays;
const bytesPerDay = (final.bytes - warm.bytes) / elapsedDays;
const daysToCeiling = Math.min(
	(STATE_LIMITS.storeRecords - 100 - final.records) / Math.max(recordsPerDay, 1),
	(STATE_LIMITS.storeBytes - STATE_LIMITS.recoveryBytes - final.bytes) / Math.max(bytesPerDay, 1),
);
const grew = (prefix: string) => (final.prefixes[prefix] ?? 0) - (baseline.prefixes[prefix] ?? 0);
const result = {
	environment: "Local Node SQLite; synthetic reports; no cloud requests. Timings/RSS are not Worker acceptance.",
	workload: { workspaces: WORKSPACES, days: DAYS, tickMs: TICK, churn: "change set differs every report; head moves every 20 ticks" },
	commands,
	retainedReceiptGrowth: grew("receipt:"),
	observationRecords: (final.prefixes["observation:"] ?? 0) + (final.prefixes["observation-result:"] ?? 0),
	activityGrowth: grew("activity:"),
	recordsPerDay: Math.round(recordsPerDay),
	bytesPerDay: Math.round(bytesPerDay),
	projectedDaysToCeiling: Math.round(daysToCeiling),
	runtimeMs,
	maxSqlStatementsPerCommand: maxStatements,
	hotStateBytes: jsonBytes(runtime.state()),
	snapshotBytes: jsonBytes(snapshot),
	...store.usage(),
	prefixes: final.prefixes,
	pageQueryPlan: plan,
	gatewayBytes: transfer.byteLength,
	gatewayBufferMs: Math.round(performance.now() - transferStarted),
	nodeRssBytes: process.memoryUsage().rss,
	limits: STATE_LIMITS,
};
const windows = Math.ceil((TICKS * TICK) / CHANGE_EVENT_INTERVAL);
const failures = [
	transfer.byteLength !== bytes && "gateway transfer",
	runtime.state().activity.length !== STATE_LIMITS.recentActivity && "recent activity window",
	Object.keys(runtime.state().receipts).length && "hot receipts",
	result.retainedReceiptGrowth !== 0 && "observation receipts retained",
	result.observationRecords > 4 * WORKSPACES && "observation slots",
	(final.prefixes["workspace-result:"] ?? 0) !== 0 && "workspace result templates",
	result.activityGrowth > WORKSPACES * (windows + 1) && "change event coalescing",
	result.hotStateBytes >= STATE_LIMITS.admissionBytes && "hot state bytes",
	result.projectedDaysToCeiling < 180 && "sustained capacity horizon",
].filter(Boolean);
if (failures.length) throw new Error(`Bounded storage measurement failed: ${failures.join(", ")}`);
await mkdir("dist/state-verification", { recursive: true });
await writeFile("dist/state-verification/measurements.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
db.close();
