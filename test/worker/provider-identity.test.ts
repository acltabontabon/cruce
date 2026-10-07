import { describe, expect, it, vi } from "vitest";
import type { Actor, Artifact, Command, Repository, Workspace } from "../../src/shared/platform.ts";
import type { StorageEnv } from "../../src/worker/artifacts.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { NamespaceRuntime } from "../../src/worker/namespace-runtime.ts";
import { ProviderIdentity } from "../../src/worker/provider-identity.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import type { Store } from "../../src/worker/store.ts";
import { ACCOUNT, memory, provider } from "./artifacts-fixture.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: StorageEnv,
		) {}
	},
}));
vi.mock("../../src/worker/store.ts", async (original) => ({ ...(await original<object>()), sqlStore: (store: Store) => store }));
const actor: Actor = { id: "owner", userId: "owner", name: "Owner", kind: "human" };
const repository: Repository = {
	id: "repo",
	namespaceId: "team",
	name: "Source",
	defaultBranch: "main",
	createdAt: 1000,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
async function fixture() {
	const p = provider(),
		{ store } = memory(),
		namespaceStore = memory().store;
	const namespace = new NamespaceRuntime({ storage: { sql: namespaceStore } } as unknown as DurableObjectState, p.env);
	namespace.initialize({ id: "team", ownerId: "owner", name: "Team", handle: "team", kind: "personal", createdAt: 1000 });
	namespace.saveRepository({ actor }, structuredClone(repository));
	const git = new GitWorkspace(new MemoryFs() as never);
	const fetch = vi.spyOn(git, "fetch").mockResolvedValue(null);
	const push = vi.spyOn(git, "push").mockResolvedValue({} as never);
	const runtime = new RepositoryRuntime(store, git, namespace, p.env, () => 1000);
	runtime.initialize(repository);
	let sequence = 0;
	const command = (tool: string, extra: Partial<Command> = {}): Command => ({
		tool,
		namespaceId: "team",
		repositoryId: "repo",
		idempotencyKey: `op-${sequence++}`,
		...extra,
	});
	const run = (cmd: Command) => new RepositoryRuntime(store, git, namespace, p.env, () => 1001).command(cmd, { actor });
	const attach = async () => {
		const workspace = (await run(command("start_workspace", { title: "Work", baseRevision: runtime.state().sourceHead }))) as Workspace;
		const cmd = command("attach_workspace", {
			workspaceId: workspace.id,
			execution: { id: workspace.id, checkoutId: "checkout", machineId: "machine", kind: "worktree", owned: true },
		});
		return { workspace, cmd };
	};
	return { p, store, namespace, git, fetch, push, runtime, command, run, attach };
}

describe("provider identity through interrupted resource operations", () => {
	it.each(["canonical", "fork", "source", "evidence"])(
		"rejects recreated %s before source access and resumes with the original identity and reservation",
		async (kind) => {
			const f = await fixture();
			let cmd = f.command("provision_repository"),
				name = repository.storageName!;
			if (kind !== "canonical") {
				await f.run(cmd);
				const attached = await f.attach();
				cmd = attached.cmd;
				name = `repo-repo-workspace-${attached.workspace.id}`;
				if (kind !== "fork") {
					await f.run(cmd);
					const base = f.runtime.state().sourceHead!;
					const head = await f.git.commit({
						ref: "refs/heads/work",
						parent: base,
						files: { "work.txt": "work" },
						message: "Work",
						author: { name: "Owner", email: "owner@local", timestamp: 2 },
					});
					f.fetch.mockResolvedValue(head);
					cmd = f.command(kind === "source" ? "publish_revision" : "publish_artifact", {
						workspaceId: attached.workspace.id,
						revision: kind === "source" ? head : base,
						ref: "work",
						content: "Reported evidence",
					});
					name = kind === "source" ? "repo-repo-artifacts" : "repo-repo-evidence";
					f.push.mockRejectedValueOnce(new Error("push response lost"));
				}
			}
			if (kind === "canonical" || kind === "fork") f.p.revokeToken.mockRejectedValueOnce(new Error("cleanup response lost"));
			await expect(f.run(cmd)).rejects.toThrow();
			const original = { ...f.p.infos.get(`ns-team-${name}`)! };
			expect(new ProviderIdentity(f.store).expected(name)).toBe(original.id);
			const state = structuredClone(f.runtime.state()),
				reservations = structuredClone(f.namespace.snapshot({ actor }).reservations);
			const tokens = f.p.createToken.mock.calls.length,
				fetches = f.fetch.mock.calls.length,
				pushes = f.push.mock.calls.length;
			f.p.infos.set(`ns-team-${name}`, { ...original, id: "replacement" });
			await expect(f.run(cmd)).rejects.toThrow("identity changed");
			expect(f.p.createToken).toHaveBeenCalledTimes(tokens);
			expect(f.fetch).toHaveBeenCalledTimes(fetches);
			expect(f.push).toHaveBeenCalledTimes(pushes);
			expect(f.runtime.state()).toEqual(state);
			expect(f.namespace.snapshot({ actor }).reservations).toEqual(reservations);
			f.p.infos.set(`ns-team-${name}`, original);
			for (const changed of [{ CRUCE_STORAGE_ACCOUNT_ID: "b".repeat(32) }, { CRUCE_ARTIFACTS_NAMESPACE: "other" }]) {
				Object.assign(f.p.env, changed);
				const lookups = f.p.get.mock.calls.length;
				await expect(f.run(cmd)).rejects.toThrow("identity changed");
				expect(f.p.get).toHaveBeenCalledTimes(lookups);
				expect(f.runtime.state()).toEqual(state);
				expect(f.namespace.snapshot({ actor }).reservations).toEqual(reservations);
				Object.assign(f.p.env, { CRUCE_STORAGE_ACCOUNT_ID: ACCOUNT, CRUCE_ARTIFACTS_NAMESPACE: "cruce" });
			}
			const result = await f.run(cmd);
			expect(await f.run(cmd)).toEqual(result);
			const completed = f.namespace.snapshot({ actor }).reservations;
			expect(completed.map((r) => r.id)).toEqual(reservations.map((r) => r.id));
			expect(completed.at(-1)?.state).toBe("complete");
			expect(new ProviderIdentity(f.store).expected(name)).toBe(original.id);
			if (kind === "source" || kind === "evidence") {
				expect(f.runtime.state().artifacts).toHaveLength(1);
				expect((result as Artifact).storage.providerId).toBe(original.id);
			}
		},
	);
	it.each(["none", "canonical", "retained"])(
		"promotes through the recorded binding identities and refuses a replaced repository (replaced: %s)",
		async (replaced) => {
			const f = await fixture();
			await f.run(f.command("provision_repository"));
			const { workspace, cmd: attach } = await f.attach();
			await f.run(attach);
			const base = f.runtime.state().sourceHead!;
			const head = await f.git.commit({
				ref: "refs/heads/work",
				parent: base,
				files: { "work.txt": "work" },
				message: "Work",
				author: { name: "Owner", email: "owner@local", timestamp: 2 },
			});
			f.fetch.mockResolvedValue(head);
			const artifact = (await f.run(f.command("publish_revision", { workspaceId: workspace.id, revision: head, ref: "work" }))) as Artifact;
			const proposal = (await f.run(f.command("create_proposal", { artifactId: artifact.id, title: "Work" }))) as { id: string };
			await f.run(f.command("review_proposal", { proposalId: proposal.id, revision: head, outcome: "approve", reason: "Reviewed" }));
			// Only the Git wire is simulated; repository lookup, identity checks and tokens use the binding host.
			let canonical = base;
			vi.spyOn(f.git, "remoteRefs").mockImplementation(async () => [{ ref: "refs/heads/main", oid: canonical }]);
			f.push.mockImplementation(async (input) => {
				await input.expected!.beforeUpdate();
				canonical = input.expected!.next;
				return { ok: true } as never;
			});
			const name = replaced === "canonical" ? repository.storageName! : artifact.storage.repository;
			if (replaced !== "none") f.p.infos.get(`ns-team-${name}`)!.id = "replacement";
			const pushes = f.push.mock.calls.length;
			const promote = f.run(f.command("promote_proposal", { proposalId: proposal.id }));
			if (replaced === "none") {
				expect(await promote).toMatchObject({ state: "complete", from: base, to: head });
				expect(f.runtime.state().sourceHead).toBe(head);
				expect(f.push).toHaveBeenCalledTimes(pushes + 1);
				expect(new ProviderIdentity(f.store).expected(repository.storageName!)).toBe(f.runtime.state().canonical!.id);
			} else {
				await expect(promote).rejects.toThrow("identity changed");
				expect(f.push).toHaveBeenCalledTimes(pushes);
				expect(canonical).toBe(base);
				expect(f.runtime.state().sourceHead).toBe(base);
				expect(f.runtime.state().promotions[0].state).toBe("uncertain");
			}
		},
	);
	it("rechecks a fork after a publication checkpoint and refuses to adopt identity-less retained source", async () => {
		const f = await fixture();
		await f.run(f.command("provision_repository"));
		const { workspace, cmd: attach } = await f.attach();
		await f.run(attach);
		const base = f.runtime.state().sourceHead!;
		const cmd = f.command("publish_revision", { workspaceId: workspace.id, revision: base, ref: "main" });
		f.fetch.mockResolvedValue(base);
		f.push.mockRejectedValueOnce(new Error("lost push"));
		await expect(f.run(cmd)).rejects.toThrow("lost push");
		const fork = f.runtime.state().workspaces[0].fork!;
		f.p.infos.get(`ns-team-${fork.name}`)!.id = "replacement";
		const tokens = f.p.createToken.mock.calls.length;
		await expect(f.run(cmd)).rejects.toThrow("identity changed");
		expect(f.p.createToken).toHaveBeenCalledTimes(tokens);
		f.p.infos.get(`ns-team-${fork.name}`)!.id = fork.id;
		const artifact = (await f.run(cmd)) as Artifact;
		f.store.delete(`provider-repository:${artifact.storage.repository}`);
		const state = f.runtime.state();
		delete (state.artifacts[0].storage as Partial<Artifact["storage"]>).providerId;
		f.store.put("repository", state);
		const tokensBefore = f.p.createToken.mock.calls.length;
		await expect(f.run(f.command("publish_revision", { workspaceId: workspace.id, revision: base, ref: "main" }))).rejects.toThrow(
			"administrator reconciliation",
		);
		expect(f.p.createToken).toHaveBeenCalledTimes(tokensBefore);
	});
});
