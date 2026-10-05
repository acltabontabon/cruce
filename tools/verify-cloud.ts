/** Explicit, opt-in integration check. Never reads an implicit operator credential. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { initialWorkspace, WorkspaceController } from "../src/core/ownership.ts";
import type { Actor, Artifact, Command, Repository, Session } from "../src/shared/platform.ts";
import { ResourceBoundary } from "../src/worker/deployments.ts";
import { MemoryFs } from "../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../src/worker/git/workspace.ts";
import { RepositoryRuntime } from "../src/worker/repository-runtime.ts";
import type { Store } from "../src/worker/store.ts";
import type { ConnectionGrant } from "../src/worker/workspace-runtime.ts";

const accountId = process.env.CRUCE_TEST_ACCOUNT_ID,
	token = process.env.CRUCE_TEST_TOKEN;
if (!accountId || !token) throw new Error("Set explicit CRUCE_TEST_ACCOUNT_ID and CRUCE_TEST_TOKEN for an authorized test account");
const namespace = `cruce-check-${Date.now().toString(36)}`;
const values = new Map<string, unknown>();
const store: Store = {
	get: <T>(k: string) => structuredClone(values.get(k)) as T | undefined,
	put: (k, v) => {
		values.set(k, structuredClone(v));
	},
	delete: (k) => {
		values.delete(k);
	},
};
const env = { CRUCE_SECRET: crypto.randomUUID() };
const boundary = new ResourceBoundary(store, env, { namespace });
await boundary.connect({ accountId, token, label: "Explicit foundation integration test" }, "test-owner");
const owner: Actor = { id: "test-owner", userId: "test-owner", name: "Foundation verification", kind: "human" };
const actor: Actor = { id: "test-agent", userId: owner.id, name: "Verification agent", kind: "agent", connectionId: "test-connection" };
const workspace = new WorkspaceController(
	initialWorkspace({
		id: namespace,
		handle: namespace,
		name: "Isolated foundation verification",
		ownerId: owner.id,
		kind: "personal",
		createdAt: 1791158400000,
	}),
	Date.now(),
);
workspace.state.policy.dailyLimit = 10;
const repository: Repository = {
	id: "repository",
	workspaceId: namespace,
	name: "foundation-check",
	defaultBranch: "trunk",
	createdAt: 1791158400000,
	source: { kind: "artifacts", storageName: "repo-repository" },
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
workspace.repository(workspace.authority(owner), repository);
const git = new GitWorkspace(new MemoryFs() as never);
const runtime = new RepositoryRuntime(
	store,
	git,
	{
		authority: (g: ConnectionGrant, id?: string) => workspace.authority(g.actor, id, g.scopes, g.repositories),
		repository: () => repository,
		reserve: (
			g: ConnectionGrant,
			id: string,
			key: string,
			fingerprint: string,
			action: Parameters<WorkspaceController["reserve"]>[3],
			session?: string,
		) => workspace.reserve(workspace.authority(g.actor, id, g.scopes, g.repositories), key, fingerprint, action, session),
		settle: (id: string, state: "complete" | "uncertain" | "released") => {
			workspace.state.reservations.find((r) => r.id === id)!.state = state;
		},
		resourceConfiguration: () => ({ namespace, account: store.get("resource-account"), policy: workspace.state.policy }),
	},
	env,
);
runtime.initialize(repository);
let sequence = 0;
const grant = { actor, scopes: ["cruce:read", "session:write", "revision:publish"], repositories: [repository.id] };
const call = (tool: string, fields: Partial<Command> = {}, connection: ConnectionGrant = grant) =>
	runtime.command(
		{ tool, workspaceId: namespace, repositoryId: repository.id, idempotencyKey: `operation-${++sequence}`, ...fields },
		connection,
	);
try {
	const provision = (await call("provision_repository", {}, { actor: owner })) as { revision: string };
	console.log("Hosted repository provisioned with trunk default branch");
	const session = (await call("start_session", { title: "Live exact Git verification", baseRevision: provision.revision })) as Session;
	const attach = {
		sessionId: session.id,
		execution: { id: session.id, checkoutId: "isolated-test-checkout", machineId: "verification", kind: "worktree" as const, owned: true },
		idempotencyKey: "attach-test",
	};
	// Artifacts forks are asynchronous. Repeat the same operation; never another reservation.
	for (let i = 0; ; i++) {
		try {
			await call("attach_session", attach);
			break;
		} catch (error) {
			if (i >= 4) throw error;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	console.log("Isolated hosted session fork verified");
	const revision = await git.commit({
		ref: "refs/heads/check",
		parent: provision.revision,
		files: { "check.txt": "Exact source publication\n" },
		message: "Verify exact Git publication",
		author: { name: "Verification agent", email: "verify@cruce.invalid", timestamp: 1791158400 },
	});
	const artifact = (await call("publish_revision", {
		sessionId: session.id,
		revision,
		pack: Buffer.from(await git.exportPack(revision)).toString("base64"),
		idempotencyKey: "publish-test",
	})) as Artifact;
	assert.equal(artifact.revision, revision);
	const host = await boundary.host(),
		remote = await host.info(artifact.storage.repository);
	const independent = new GitWorkspace(new MemoryFs() as never);
	await independent.ensureInit();
	const read = await host.withToken(artifact.storage.repository, "read", (t) =>
		independent.fetch({
			url: remote.remote,
			token: t,
			remoteBranch: artifact.storage.ref!.replace(/^refs\/heads\//, ""),
			localRef: "refs/heads/verify",
		}),
	);
	assert.equal(read.result, revision);
	assert.equal((await independent.readFiles(revision))["check.txt"], "Exact source publication\n");
	await call("end_session", { sessionId: session.id });
	assert.equal(runtime.state().artifacts[0].revision, revision);
	const result = {
		namespace,
		repository,
		session: runtime.state().sessions[0],
		artifact,
		reservations: workspace.state.reservations,
		verifiedAt: new Date().toISOString(),
		checks: [
			"namespace",
			"non-main default branch",
			"hosted fork",
			"exact Git pack publication",
			"independent source fetch",
			"source retention after session end",
		],
		deployment: "not configured",
	};
	await mkdir("dist/live-verification", { recursive: true });
	await writeFile("dist/live-verification/result.json", JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ namespace, revision, artifactId: artifact.id, checks: result.checks }));
} catch (error) {
	console.error(`Live verification stopped: ${(error as Error).name}; namespace ${namespace} retained for diagnosis`);
	// No provider body or credential is printed.
	throw new Error("Live verification failed; inspect the operation with the configured test account");
}
