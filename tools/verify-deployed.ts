/** Opt-in, staged verification through the deployed OAuth, command and native Git gateways. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Credentials, login } from "../runner/oauth.ts";
import { DEFAULT_AGENT_SCOPES } from "../src/core/capabilities.ts";
import { gitRemotePath } from "../src/shared/git-access.ts";
import type { Artifact, Command, Proposal, RepositorySnapshot, Workspace } from "../src/shared/platform.ts";
import { ArtifactsRestHost } from "../src/worker/artifacts.ts";
import { nativeGit } from "./verification/convergence.ts";

const root = resolve(process.env.CRUCE_VERIFY_OUTPUT_DIR ?? "dist/deployed-verification");
assert.ok(root.startsWith(`${resolve("dist")}/`), "Keep verification output and credentials in the ignored dist directory");
const origin = process.env.CRUCE_PUBLIC_ORIGIN;
const namespaceId = process.env.CRUCE_VERIFY_NAMESPACE_ID;
const repositoryId = process.env.CRUCE_VERIFY_REPOSITORY_ID;
const action = process.argv[2];
const writer = process.argv[3] ?? "a";
assert.ok(origin && new URL(origin).protocol === "https:", "Set an explicit HTTPS CRUCE_PUBLIC_ORIGIN");
assert.ok(namespaceId && repositoryId, "Set explicit CRUCE_VERIFY_NAMESPACE_ID and CRUCE_VERIFY_REPOSITORY_ID");
assert.ok(["a", "b"].includes(writer), "Writer must be a or b");
await mkdir(root, { recursive: true });
const credentials = new Credentials(origin, `gateway-check-${writer}`);
credentials.path = resolve(root, `credentials-${writer}.json`);
await credentials.load();
const statePath = resolve(root, `writer-${writer}.json`);
interface WriterState {
	workspace: Workspace;
	checkout: string;
	publications: { command: Command; source: Artifact; evidence: Artifact; proposal: Proposal }[];
}
const receiptPath = resolve(root, "checks.json");
const checks: { at: string; check: string; details: unknown }[] = JSON.parse(await readFile(receiptPath, "utf8").catch(() => "[]"));
async function record(check: string, details: unknown) {
	checks.push({ at: new Date().toISOString(), check, details });
	await writeFile(receiptPath, JSON.stringify(checks, null, 2));
	console.log(JSON.stringify({ check }));
}
const token = () => {
	const value = credentials.data.tokens?.access_token;
	assert.ok(value, "Authorize this test connection first");
	return value;
};
async function commandResponse(command: Partial<Command>) {
	return fetch(`${origin}/mcp/command`, {
		method: "POST",
		headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
		body: JSON.stringify({ namespaceId, repositoryId, ...command }),
		redirect: "manual",
		signal: AbortSignal.timeout(60000),
	});
}
async function call<T>(command: Partial<Command>): Promise<T> {
	const response = await commandResponse(command);
	assert.equal(response.status, 200, `Deployed ${command.tool} returned HTTP ${response.status}`);
	return (await response.json()) as T;
}
const snapshot = () => call<RepositorySnapshot>({ tool: "get_repository" });
const remote = (workspaceId?: string) => `${origin}${gitRemotePath(namespaceId!, repositoryId!, workspaceId)}`;
const loadState = async () => JSON.parse(await readFile(statePath, "utf8")) as WriterState;
const saveState = (state: WriterState) => writeFile(statePath, JSON.stringify(state, null, 2));

async function main() {
	if (action === "auth") {
		await login(origin!, credentials, DEFAULT_AGENT_SCOPES);
		await record("deployed OAuth connection authorized", { writer, repositoryId });
		return;
	}
	if (action === "start") {
		const checkout = resolve(root, `checkout-${writer}`);
		const existing = await stat(checkout).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		assert.ok(
			!existing,
			"Checkout already exists; continue its staged run or choose a fresh CRUCE_VERIFY_OUTPUT_DIR before authorizing a new run",
		);
		const view = await snapshot();
		const baseRevision = view.sourceHead!;
		const key = `gateway-start-${writer}`;
		const workspace = await call<Workspace>({
			tool: "start_workspace",
			baseRevision,
			title: `Gateway test writer ${writer}`,
			idempotencyKey: key,
		});
		const attached = await call<Workspace>({
			tool: "attach_workspace",
			workspaceId: workspace.id,
			idempotencyKey: `gateway-attach-${writer}`,
			execution: {
				id: workspace.id,
				checkoutId: workspace.id,
				machineId: "deployed-gateway-verifier",
				kind: "clone",
				owned: true,
				branch: "work",
			},
		});
		const replay = await call<Workspace>({
			tool: "start_workspace",
			baseRevision,
			title: `Gateway test writer ${writer}`,
			idempotencyKey: key,
		});
		assert.equal(replay.id, workspace.id);
		await nativeGit(["clone", remote(), checkout], token());
		await nativeGit(["-C", checkout, "remote", "add", "workspace", remote(workspace.id)]);
		await nativeGit(["-C", checkout, "checkout", "-b", "work", baseRevision]);
		await writeFile(
			resolve(checkout, `writer-${writer}.test.mjs`),
			`import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('writer ${writer} isolated contribution', () => assert.equal('${writer}', '${writer}'));\n`,
		);
		await nativeGit(["-C", checkout, "add", "."]);
		await nativeGit(["-C", checkout, "commit", "-m", `Gateway writer ${writer} contribution`]);
		await saveState({ workspace: attached, checkout, publications: [] });
		await record("authenticated writer attached and canonical cloned", {
			writer,
			workspaceId: workspace.id,
			ownerId: attached.ownerId,
			attachedBy: attached.execution?.attachedBy,
			baseRevision,
			fork: attached.fork,
		});
		return;
	}
	const state = await loadState();
	if (action === "publish") {
		const suite = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap"], { cwd: state.checkout });
		const tests = Number(suite.stdout.match(/# tests (\d+)/)?.[1]);
		assert.ok(tests >= 1);
		assert.match(suite.stdout, /# fail 0\b/);
		const revision = await nativeGit(["-C", state.checkout, "rev-parse", "HEAD"]);
		await nativeGit(["-C", state.checkout, "push", "workspace", "HEAD:work"], token());
		const cmd: Command = {
			tool: "publish_revision",
			namespaceId,
			repositoryId,
			workspaceId: state.workspace.id,
			revision,
			ref: "work",
			idempotencyKey: `gateway-publish-${revision}`,
		};
		// The deployed operation completes before the client discards its response body.
		// This checks client response loss; it does not inject a provider-side timeout.
		const lost = await commandResponse(cmd);
		assert.equal(lost.status, 200);
		await lost.body?.cancel();
		const source = await call<Artifact>(cmd);
		assert.deepEqual(await call<Artifact>(cmd), source);
		assert.equal(source.revision, revision);
		const view = await snapshot();
		assert.equal(view.artifacts.filter((a) => a.id === source.id).length, 1);
		const evidence = await call<Artifact>({
			tool: "publish_artifact",
			workspaceId: state.workspace.id,
			revision,
			title: "Gateway test results",
			content: JSON.stringify({ revision, tests, outcome: "pass", command: "node --test --test-reporter=tap" }),
			idempotencyKey: `gateway-evidence-${revision}`,
		});
		const proposal = await call<Proposal>({
			tool: "create_proposal",
			artifactId: source.id,
			title: `Gateway ${writer}: ${revision.slice(0, 8)}`,
			idempotencyKey: `gateway-proposal-${revision}`,
		});
		await call({
			tool: "record_verification",
			proposalId: proposal.id,
			revision,
			artifactId: evidence.id,
			kind: "tests",
			outcome: "pass",
			reason: "Complete isolated Node suite passed; authenticated agent report",
			idempotencyKey: `gateway-verification-${revision}`,
		});
		const denied = await commandResponse({
			tool: "promote_proposal",
			proposalId: proposal.id,
			idempotencyKey: `gateway-agent-promotion-${revision}`,
		});
		assert.equal(denied.status, 403, "OAuth agent must not promote source");
		await denied.body?.cancel();
		state.publications.push({ command: cmd, source, evidence, proposal });
		await saveState(state);
		await record("publication survives discarded response and exact replay", {
			writer,
			revision,
			source,
			evidence,
			proposal,
			canonical: view.canonical,
			reviewUrl: `${origin}/?namespace=${namespaceId}&repository=${repositoryId}#/work/${proposal.id}`,
		});
		return;
	}
	if (action === "merge") {
		const before = await call<Workspace>({ tool: "get_workspace", workspaceId: state.workspace.id });
		await nativeGit(["-C", state.checkout, "fetch", "origin", "trunk"], token());
		assert.deepEqual(await call<Workspace>({ tool: "get_workspace", workspaceId: state.workspace.id }), before);
		await nativeGit(["-C", state.checkout, "merge", "--no-ff", "-m", "Incorporate authenticated accepted source", "FETCH_HEAD"]);
		await record("fetch alone does not incorporate accepted source", {
			writer,
			immutableBase: before.baseRevision,
			incorporated: await nativeGit(["-C", state.checkout, "rev-parse", "HEAD"]),
		});
		return;
	}
	if (action === "check") {
		const view = await snapshot();
		const canonical = (await nativeGit(["ls-remote", remote(), "refs/heads/trunk"], token())).split(/\s/)[0];
		assert.equal(canonical, view.sourceHead);
		await record("gateway canonical matches recorded accepted source", { canonical, view });
		return;
	}
	if (action === "cleanup") {
		await call({ tool: "end_workspace", workspaceId: state.workspace.id, idempotencyKey: `gateway-end-${writer}` });
		for (let attempt = 0; attempt < 12; attempt++) {
			const result = await call<{ state: string }>({
				tool: "cleanup_workspace",
				workspaceId: state.workspace.id,
				idempotencyKey: `gateway-cleanup-${writer}`,
			});
			if (result.state === "deleted") {
				await record("completed writer fork cleaned up", { writer, workspaceId: state.workspace.id });
				return;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		throw new Error("Cleanup remains pending; preserve the operation identity and retained source");
	}
	if (action === "revoke") {
		const tokens = credentials.data.tokens!;
		const discovery = (await fetch(`${origin}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
			revocation_endpoint: string;
		};
		assert.equal(new URL(discovery.revocation_endpoint).origin, origin);
		const response = await fetch(discovery.revocation_endpoint, {
			method: "POST",
			body: new URLSearchParams({
				token: tokens.refresh_token!,
				token_type_hint: "refresh_token",
				client_id: credentials.clientInformation()!.client_id,
			}),
		});
		assert.equal(response.status, 200);
		await response.body?.cancel();
		// KV propagation can delay revocation. Keep the original token and measure rejection.
		const started = Date.now();
		let rejection = 0;
		for (let attempt = 0; attempt < 30; attempt++) {
			const replay = await commandResponse(state.publications[0]!.command);
			rejection = replay.status;
			await replay.body?.cancel();
			if (rejection === 401) break;
			assert.equal(rejection, 200);
			await new Promise((r) => setTimeout(r, 2000));
		}
		assert.equal(rejection, 401, "Revoked connection must reject a previously completed mutation replay");
		const git = await fetch(`${remote(state.workspace.id)}/info/refs?service=git-upload-pack`, {
			headers: { authorization: `Basic ${Buffer.from(`arbitrary-label:${token()}`).toString("base64")}` },
			redirect: "manual",
		});
		assert.equal(git.status, 401);
		await git.body?.cancel();
		const refresh = await fetch(`${origin}/oauth/token`, {
			method: "POST",
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token!,
				client_id: credentials.clientInformation()!.client_id,
			}),
		});
		assert.equal(refresh.status, 400);
		const error = (await refresh.json()) as { error: string };
		assert.equal(error.error, "invalid_grant");
		await record("revoked OAuth grant rejects saved mutation replay, Git Basic credential and refresh", {
			writer,
			rejectionDelayMs: Date.now() - started,
			gitStatus: git.status,
			refreshStatus: refresh.status,
		});
		return;
	}
	if (action === "scope") {
		const refresh = async (scope: string) => {
			const response = await fetch(`${origin}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: credentials.data.tokens!.refresh_token!,
					client_id: credentials.clientInformation()!.client_id,
					scope,
					resource: `${origin}/mcp`,
				}),
			});
			assert.equal(response.status, 200, "Test connection refresh must succeed");
			const tokens = (await response.json()) as NonNullable<Credentials["data"]["tokens"]>;
			await credentials.saveTokens(tokens);
			return tokens;
		};
		const narrowed = await refresh("cruce:read");
		assert.equal(narrowed.scope, "cruce:read");
		await snapshot();
		const replay = await commandResponse(state.publications[0]!.command);
		assert.equal(replay.status, 403, "Read-only authority must reject completed publication replay");
		await replay.body?.cancel();
		const restored = await refresh(DEFAULT_AGENT_SCOPES.join(" "));
		assert.ok(restored.scope?.split(" ").includes("revision:publish"));
		await record("downscoped OAuth authority permits reads but rejects completed publication replay", {
			writer,
			readStatus: 200,
			replayStatus: replay.status,
			restoredPreviouslyApprovedScopes: true,
		});
		return;
	}
	if (action === "audit") {
		const accountId = process.env.CRUCE_TEST_ACCOUNT_ID;
		const accountToken = process.env.CRUCE_TEST_TOKEN;
		assert.ok(accountId && accountToken, "Explicit test account credentials required; no CLI fallback");
		const host = new ArtifactsRestHost(accountId, namespaceId!, accountToken);
		const view = await snapshot();
		const info = await host.info(view.repository.storageName!);
		let revokedToken = "";
		const issuedAt = Date.now();
		const probe = await host.withToken(info.name, "read", async (value) => {
			revokedToken = value;
			const valid = await fetch(`${info.remote}/info/refs?service=git-upload-pack`, {
				headers: { authorization: `Bearer ${value}` },
				redirect: "manual",
			});
			assert.equal(valid.status, 200);
			await valid.body?.cancel();
		});
		const replay = await fetch(`${info.remote}/info/refs?service=git-upload-pack`, {
			headers: { authorization: `Bearer ${revokedToken}` },
			redirect: "manual",
		});
		revokedToken = "";
		assert.ok([401, 403].includes(replay.status));
		await replay.body?.cancel();
		assert.ok(Date.now() - issuedAt < 60000, "Rejection must precede natural 60-second expiry");
		await record("provider rejects a previously valid, explicitly revoked Git token before expiry", {
			tokenId: probe.tokenId,
			status: replay.status,
			elapsedMs: Date.now() - issuedAt,
		});
		const retained = resolve(root, "retained.git");
		await nativeGit(["init", "--bare", retained]);
		for (const artifact of view.artifacts) {
			const storage = await host.info(artifact.storage.repository);
			await host.withToken(storage.name, "read", (value) =>
				nativeGit(["--git-dir", retained, "fetch", storage.remote, `${artifact.storage.ref}:refs/heads/${artifact.id}`], value),
			);
			assert.equal(await nativeGit(["--git-dir", retained, "rev-parse", `refs/heads/${artifact.id}`]), artifact.storage.revision);
		}
		await record("independent provider fetch verifies every retained artifact", {
			accountId,
			namespaceId,
			artifacts: view.artifacts,
			canonical: view.canonical,
		});
		return;
	}
	throw new Error("Choose auth, start, publish, merge, check, cleanup, scope, revoke or audit");
}
main().catch((error: unknown) => {
	if (error instanceof assert.AssertionError) console.error(error.message);
	// Never emit fetch/provider bodies, Git stderr or credentials in failure output.
	console.error(
		`Deployed verification stopped (${error instanceof Error ? error.name : "unknown error"}); preserve resources and retry identities.`,
	);
	process.exitCode = 1;
});
