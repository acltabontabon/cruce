import { describe, expect, it, vi } from "vitest";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository } from "../../src/core/platform.ts";
import { repositoryLifecycleView } from "../../src/core/repository-lifecycle.ts";
import type { Actor, Command, Repository, RepositoryState } from "../../src/shared/platform.ts";
import { RepositoryLifecycleRuntime } from "../../src/worker/repository-lifecycle.ts";
import { memoryStore } from "../../src/worker/store.ts";

const owner: Actor = { id: "owner", userId: "owner", kind: "human", name: "Owner" };
const repo: Repository = {
	id: "repo",
	namespaceId: "ns",
	name: "sample",
	defaultBranch: "main",
	createdAt: 1,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
function fixture() {
	const namespace = new NamespaceController(
		initialNamespace({ id: "ns", handle: "ns", name: "Namespace", kind: "shared", ownerId: owner.id, createdAt: 1 }),
		1000,
	);
	namespace.repository(namespace.authority(owner), structuredClone(repo));
	const store = memoryStore();
	const state = initialRepository(structuredClone(repo));
	state.canonical = { id: "canonical-id", name: repo.storageName, remote: "https://example.invalid/canonical" };
	store.put("repository", state);
	store.put(`provider-repository:${repo.storageName}`, "canonical-id");
	store.put("provider-repository:source-one", "source-id");
	store.put("provider-repository:fork-old", "fork-id");
	store.put("archive:old", { source: "retained" });
	let now = 1000;
	const remove = vi.fn(async (_name: string, _id?: string) => true);
	const resetCache = vi.fn();
	const schedule = vi.fn(async (_at: number) => {});
	const port = {
		authority: (g: { actor: Actor }, id: string) => namespace.authority(g.actor, id, ["cruce:read"], [id]),
		lifecycle: vi.fn((g: { actor: Actor }, id: string, lifecycle: NonNullable<Repository["lifecycle"]>) =>
			namespace.lifecycle(namespace.authority(g.actor, id), lifecycle),
		),
		lifecycleReservations: async (_g: unknown, id: string, operationId?: string) =>
			namespace.state.reservations.filter(
				(r) => r.repositoryId === id && r.id !== operationId && ["reserved", "uncertain"].includes(r.state),
			),
		releaseReservation: vi.fn((_g: unknown, _id: string, reservationId: string) => {
			const r = namespace.state.reservations.find((r) => r.id === reservationId)!;
			r.state = "released";
			return r;
		}),
		reserve: async (g: { actor: Actor }, id: string, key: string, fingerprint: string, action: "repository.delete") =>
			namespace.reserve(namespace.authority(g.actor, id), key, fingerprint, action),
		settle: vi.fn(async (id: string, state: "complete" | "uncertain") => {
			namespace.state.reservations.find((r) => r.id === id)!.state = state;
		}),
		host: async () => ({ remove }) as never,
		resetCache,
		schedule,
	};
	const restart = () => new RepositoryLifecycleRuntime(store, port, () => now);
	const runtime = restart();
	const repository = () => structuredClone(namespace.state.repositories[0]);
	const command = (tool: string, key = tool): Command => ({
		tool,
		idempotencyKey: key,
		namespaceId: repo.namespaceId,
		repositoryId: repo.id,
		...(tool === "delete_repository" ? { confirmation: repo.name } : {}),
	});
	const call = (tool: string, key?: string, actor = owner) => runtime.command(repository(), command(tool, key), { actor });
	return {
		store,
		namespace,
		runtime,
		restart,
		command,
		repository,
		call,
		port,
		remove,
		resetCache,
		advance: () => {
			now += 30_000;
		},
	};
}
describe("repository lifecycle", () => {
	it("treats disconnected attachments, open changes, promotions and uncertainty as blockers", () => {
		const f = fixture();
		const state = f.store.get<RepositoryState>("repository")!;
		state.workspaces = [{ state: "disconnected", execution: {} }] as never;
		state.proposals = [{ state: "promoting" }] as never;
		state.promotions = [{ state: "uncertain" }] as never;
		const view = repositoryLifecycleView(state, f.namespace.authority(owner, repo.id), true);
		expect(view.blockers).toHaveLength(4);
		// Deletion ends unfinished work; only in-flight promotions and provider operations hold it.
		expect(view.deletionBlockers).toEqual(["Recover unfinished promotions.", "Recover unfinished resource operations."]);
	});
	it("deletes a repository with attached and detached workspaces and an open change, removing their forks", async () => {
		const f = fixture();
		const state = f.store.get<RepositoryState>("repository")!;
		state.workspaces = [
			{ id: "attached", state: "active", execution: { id: "x" }, fork: { name: "fork-attached", id: "attached-id" } },
			{ id: "detached", state: "detached", fork: { name: "fork-detached", id: "detached-id" } },
		] as never;
		state.proposals = [{ id: "change", state: "open" }] as never;
		f.store.put("repository", state);
		const view = repositoryLifecycleView(state, f.namespace.authority(owner, repo.id));
		expect(view.unfinished).toEqual({ workspaces: 2, attached: 1, changes: 1 });
		await expect(f.call("archive_repository")).rejects.toThrow("Repository retirement has blockers");
		// Five provider repositories: one bounded attempt, then a retry of the same operation finishes.
		expect(await f.call("delete_repository")).toEqual({ state: "deleting" });
		expect(await f.call("delete_repository")).toEqual({ state: "deleted" });
		expect(f.remove.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(["fork-attached", "fork-detached", "repo-repo"]));
		expect(f.remove.mock.calls.at(-1)?.[0]).toBe("repo-repo");
	});
	it("lets the owner release an unsettled cloud operation so deletion can proceed", async () => {
		const f = fixture();
		f.namespace.reserve(f.namespace.authority(owner, repo.id), "stuck", "fingerprint", "revision.publish");
		f.namespace.state.reservations[0].state = "uncertain";
		const view = await f.runtime.view(f.repository(), { actor: owner }, f.namespace.authority(owner, repo.id));
		expect(view.deletionBlockers).toEqual(["Recover unfinished resource operations."]);
		expect(view.operations).toEqual([expect.objectContaining({ action: "revision.publish", state: "uncertain" })]);
		await expect(
			f.runtime.command(
				f.repository(),
				{ ...f.command("release_resource_operation"), reservationId: view.operations![0].id },
				{
					actor: { ...owner, kind: "agent" },
				},
			),
		).rejects.toThrow("Human namespace owner required");
		const released = await f.runtime.command(
			f.repository(),
			{ ...f.command("release_resource_operation"), reservationId: view.operations![0].id },
			{ actor: owner },
		);
		expect(released).toMatchObject({ deletionBlockers: [] });
		expect(f.port.releaseReservation).toHaveBeenCalledOnce();
		expect(await f.call("delete_repository")).toEqual({ state: "deleted" });
	});
	it("requires the console namespace owner, never an agent, terminal or maintainer", async () => {
		for (const actor of [
			{ ...owner, kind: "agent" as const },
			{ ...owner, connectionId: "terminal" },
			{ ...owner, id: "maintainer", userId: "maintainer" },
		]) {
			const f = fixture();
			f.namespace.state.members.maintainer = "maintainer";
			await expect(f.call("delete_repository", undefined, actor)).rejects.toThrow("Human namespace owner required");
			expect(f.remove).not.toHaveBeenCalled();
			expect(f.store.get("repository-deletion")).toBeUndefined();
		}
	});
	it("archives, restores and replays old archive receipts without archiving again", async () => {
		const f = fixture();
		await f.call("archive_repository");
		expect(f.repository().lifecycle?.state).toBe("archived");
		await f.call("restore_repository");
		await f.call("archive_repository");
		expect(f.repository().lifecycle?.state).toBe("active");
		expect(f.store.get("archive:old")).toBeDefined();
		expect(f.remove).not.toHaveBeenCalled();
		await expect(f.call("restore_repository", "archive_repository")).rejects.toThrow("Operation identity reused");
	});
	it("retries an interrupted archive synchronization and blocks new transitions", async () => {
		const f = fixture();
		f.port.lifecycle.mockImplementationOnce(() => {
			throw new Error("response lost");
		});
		await expect(f.call("archive_repository")).rejects.toThrow("response lost");
		expect(f.store.get<RepositoryState>("repository")?.repository.lifecycle?.state).toBe("archived");
		await expect(f.call("restore_repository")).rejects.toThrow("Retry the unfinished repository transition");
		await f.restart().command(f.repository(), f.command("archive_repository"), { actor: owner });
		expect(f.repository().lifecycle?.state).toBe("archived");
	});
	it("refuses retirement with resource uncertainty, observation subscriptions or wrong confirmation", async () => {
		const f = fixture();
		await expect(
			f.runtime.command(f.repository(), { ...f.command("delete_repository"), confirmation: "wrong" }, { actor: owner }),
		).rejects.toThrow("Type the repository name");
		f.namespace.reserve(f.namespace.authority(owner, repo.id), "unfinished", "fingerprint", "revision.publish");
		await expect(f.call("archive_repository")).rejects.toThrow("Repository retirement has blockers");
		f.namespace.state.reservations[0].state = "complete";
		f.store.put("observation-target:canonical", { removed: false });
		await expect(f.call("delete_repository")).rejects.toThrow("Repository retirement has blockers");
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("deletes fork and retained stores before canonical, purges records and replays a tombstone", async () => {
		const f = fixture();
		expect(await f.call("delete_repository")).toEqual({ state: "deleted" });
		expect(f.remove.mock.calls.map(([name]) => name)).toEqual(["fork-old", "source-one", "repo-repo"]);
		expect(f.remove.mock.calls.map(([, id]) => id)).toEqual(["fork-id", "source-id", "canonical-id"]);
		expect(f.store.scan("").map((r) => r.key)).toEqual(["repository", "repository-deletion"]);
		expect(f.resetCache).toHaveBeenCalledOnce();
		await f.call("delete_repository");
		expect(f.remove).toHaveBeenCalledTimes(3);
		await expect(f.call("restore_repository")).rejects.toThrow("Resume the existing repository deletion");
	});
	it("recovers a lost delete response after restart under the same reservation", async () => {
		const f = fixture();
		f.remove.mockRejectedValueOnce(new Error("response lost"));
		expect(await f.call("delete_repository")).toMatchObject({ state: "deleting" });
		expect(f.namespace.state.reservations).toHaveLength(1);
		expect(f.namespace.state.reservations[0].state).toBe("uncertain");
		f.advance();
		await f.restart().recover(f.repository());
		expect(f.repository().lifecycle?.state).toBe("deleted");
		expect(f.namespace.state.reservations).toHaveLength(1);
		expect(f.namespace.state.reservations[0].state).toBe("complete");
	});
	it("does not repeat confirmed deletion when settlement fails", async () => {
		const f = fixture();
		f.port.settle.mockRejectedValueOnce(new Error("settlement lost"));
		await f.call("delete_repository");
		expect(f.remove).toHaveBeenCalledTimes(3);
		f.advance();
		await f.restart().recover(f.repository());
		expect(f.remove).toHaveBeenCalledTimes(3);
		expect(f.repository().lifecycle?.state).toBe("deleted");
	});
	it("waits for absence and refuses recovery after owner revocation or policy denial", async () => {
		const f = fixture();
		f.remove.mockResolvedValueOnce(false);
		await f.call("delete_repository");
		expect(f.store.get("archive:old")).toBeDefined();
		f.namespace.state.policy.rules["repository.delete"] = "deny";
		f.advance();
		await f.restart().recover(f.repository());
		expect(f.remove).toHaveBeenCalledOnce();
		f.namespace.state.policy.rules["repository.delete"] = "allow";
		f.namespace.state.members.owner = "maintainer";
		await expect(f.call("delete_repository")).rejects.toThrow("Human namespace owner required");
		expect(f.remove).toHaveBeenCalledOnce();
	});
	it("purges a large retained record set in bounded restart-safe batches", async () => {
		const f = fixture();
		for (let i = 0; i < 210; i++) f.store.put(`receipt:old-${i}`, { history: true });
		await f.call("delete_repository");
		f.advance();
		await f.restart().recover(f.repository());
		f.advance();
		await f.restart().recover(f.repository());
		expect(f.repository().lifecycle?.state).toBe("deleted");
		expect(f.remove).toHaveBeenCalledTimes(3);
	});
});
