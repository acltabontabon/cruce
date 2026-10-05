/** Explicit, opt-in integration check. Never reads an implicit operator credential. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initialNamespace, NamespaceController } from "../src/core/ownership.ts";
import type { Actor, Artifact, Command, Repository, Workspace } from "../src/shared/platform.ts";
import { ResourceBoundary } from "../src/worker/deployments.ts";
import { MemoryFs } from "../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../src/worker/git/workspace.ts";
import type { ConnectionGrant } from "../src/worker/namespace-runtime.ts";
import { RepositoryRuntime } from "../src/worker/repository-runtime.ts";
import type { Store } from "../src/worker/store.ts";

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
const controller = new NamespaceController(
	initialNamespace({
		id: namespace,
		handle: namespace,
		name: "Isolated foundation verification",
		ownerId: owner.id,
		kind: "personal",
		createdAt: 1791158400000,
	}),
	Date.now(),
);
controller.state.policy.dailyLimit = 10;
const repository: Repository = {
	id: "repository",
	namespaceId: namespace,
	name: "foundation-check",
	defaultBranch: "trunk",
	createdAt: 1791158400000,
	storageName: "repo-repository",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
controller.repository(controller.authority(owner), repository);
const git = new GitWorkspace(new MemoryFs() as never);
const runtime = new RepositoryRuntime(
	store,
	git,
	{
		authority: (g: ConnectionGrant, id?: string) => controller.authority(g.actor, id, g.scopes, g.repositories),
		repository: () => repository,
		reserve: (
			g: ConnectionGrant,
			id: string,
			key: string,
			fingerprint: string,
			action: Parameters<NamespaceController["reserve"]>[3],
			workspace?: string,
		) => controller.reserve(controller.authority(g.actor, id, g.scopes, g.repositories), key, fingerprint, action, workspace),
		settle: (id: string, state: "complete" | "uncertain" | "released") => {
			controller.state.reservations.find((r) => r.id === id)!.state = state;
		},
		resourceConfiguration: () => ({ namespace, account: store.get("resource-account"), policy: controller.state.policy }),
	},
	env,
);
runtime.initialize(repository);
let sequence = 0;
const grant = { actor, scopes: ["cruce:read", "workspace:write", "revision:publish"], repositories: [repository.id] };
const call = (tool: string, fields: Partial<Command> = {}, connection: ConnectionGrant = grant) =>
	runtime.command(
		{ tool, namespaceId: namespace, repositoryId: repository.id, idempotencyKey: `operation-${++sequence}`, ...fields },
		connection,
	);
try {
	const provision = (await call("provision_repository", {}, { actor: owner })) as { revision: string };
	console.log("Hosted repository provisioned with trunk default branch");
	const workspace = (await call("start_workspace", {
		title: "Live exact Git verification",
		baseRevision: provision.revision,
	})) as Workspace;
	const attach = {
		workspaceId: workspace.id,
		execution: {
			id: workspace.id,
			checkoutId: "isolated-test-checkout",
			machineId: "verification",
			kind: "worktree" as const,
			owned: true,
		},
		idempotencyKey: "attach-test",
	};
	// Artifacts forks are asynchronous. Repeat the same operation; never another reservation.
	for (let i = 0; ; i++) {
		try {
			await call("attach_workspace", attach);
			break;
		} catch (error) {
			if (i >= 4) throw error;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	console.log("Isolated hosted workspace fork verified");
	const host = await boundary.host();
	const fork = runtime.state().workspaces[0].fork!;
	const checkout = await mkdtemp(join(tmpdir(), "cruce-live-git-"));
	let revision: string;
	try {
		const native = async (args: string[], token?: string) =>
			(
				await promisify(execFile)("git", args, {
					env: {
						...process.env,
						GIT_CONFIG_COUNT: token ? "3" : "2",
						GIT_CONFIG_KEY_0: "commit.gpgsign",
						GIT_CONFIG_VALUE_0: "false",
						GIT_CONFIG_KEY_1: "core.hooksPath",
						GIT_CONFIG_VALUE_1: "/dev/null",
						...(token ? { GIT_CONFIG_KEY_2: "http.extraHeader", GIT_CONFIG_VALUE_2: `Authorization: Bearer ${token}` } : {}),
					},
				})
			).stdout.trim();
		await host.withToken(fork.name, "read", (token) => native(["clone", fork.remote, checkout], token));
		await writeFile(join(checkout, "check.txt"), "Exact source publication\n");
		await native(["-C", checkout, "add", "check.txt"]);
		await native([
			"-C",
			checkout,
			"-c",
			"user.name=Verification",
			"-c",
			"user.email=verify@cruce.invalid",
			"commit",
			"-m",
			"Verify native Git",
		]);
		revision = await native(["-C", checkout, "rev-parse", "HEAD"]);
		await host.withToken(fork.name, "write", (token) => native(["-C", checkout, "push", "origin", "HEAD:check"], token));
		await host.withToken(fork.name, "read", (token) => native(["-C", checkout, "fetch", "origin", "check"], token));
		assert.equal(await native(["-C", checkout, "rev-parse", "FETCH_HEAD"]), revision);
	} finally {
		await rm(checkout, { recursive: true, force: true });
	}

	const artifact = (await call("publish_revision", {
		workspaceId: workspace.id,
		revision,
		ref: "check",
		idempotencyKey: "publish-test",
	})) as Artifact;
	assert.equal(artifact.revision, revision);
	const remote = await host.info(artifact.storage.repository);
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
	await call("end_workspace", { workspaceId: workspace.id });
	assert.equal(runtime.state().artifacts[0].revision, revision);
	const canonical = await host.info(repository.storageName);
	const canonicalHead = await host.withToken(repository.storageName, "read", (token) =>
		independent.fetch({ url: canonical.remote, token, remoteBranch: "trunk", localRef: "refs/cruce/canonical" }),
	);
	assert.equal(canonicalHead.result, provision.revision);
	for (let attempt = 0; ; attempt++) {
		const cleanup = (await call("cleanup_workspace", { workspaceId: workspace.id, idempotencyKey: "cleanup-test" })) as { state: string };
		if (cleanup.state === "deleted") break;
		if (attempt >= 10) throw new Error("Deletion still pending");
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	const result = {
		namespace,
		repository,
		workspace: runtime.state().workspaces[0],
		artifact,
		reservations: controller.state.reservations,
		verifiedAt: new Date().toISOString(),
		checks: [
			"namespace",
			"non-main default branch",
			"hosted fork",
			"native Git clone/push/fetch",
			"exact pushed revision publication",
			"canonical isolation",
			"fork deletion",
			"independent source fetch",
			"source retention after workspace end",
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
