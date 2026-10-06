import { describe, expect, it, vi } from "vitest";
import { ArtifactsBindingHost, ResourceBoundary } from "../../src/worker/artifacts.ts";
import { ProviderIdentity } from "../../src/worker/provider-identity.ts";

import { ACCOUNT, memory, provider } from "./artifacts-fixture.ts";

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
			const host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", ns, new ProviderIdentity(memory().store));
			expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ name: "repo", created: true });
			expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ created: false });
			expect(p.tokens.get(`ns-${ns}-repo`)).toEqual([]);
		}
		expect(p.create.mock.calls.map(([name]) => name)).toEqual(["ns-team-a-repo", "ns-team-b-repo"]);
		expect(p.create.mock.calls[0][1]?.setDefaultBranch).toBe("trunk");
	});
	it("cleans up a creation token after a lost revocation response on retry", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(memory().store));
		p.revokeToken.mockRejectedValueOnce(new Error("response lost"));
		await expect(host.ensure("repo", "owned")).rejects.toThrow("retry");
		expect(p.tokens.get("ns-team-repo")).toHaveLength(1);
		expect(await host.ensure("repo", "owned")).toMatchObject({ created: false });
		expect(p.create).toHaveBeenCalledTimes(1);
		expect(p.tokens.get("ns-team-repo")).toEqual([]);
	});
	it("validates fork ownership and parent on creation and replay", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(memory().store));
		await host.ensure("repo", "owned");
		expect(await host.fork("repo", "fork", "workspace")).toMatchObject({ name: "fork", created: true });
		expect(await host.fork("repo", "fork", "workspace")).toMatchObject({ created: false });
		p.infos.get("ns-team-fork")!.source = "artifacts:cruce/unrelated";
		await expect(host.fork("repo", "fork", "workspace")).rejects.toThrow("parent mismatch");
		await expect(host.ensure("repo", "other owner")).rejects.toThrow("ownership mismatch");
	});
	it("mints 60-second tokens and revokes them even when Git fails, within the handle lifetime", async () => {
		const p = provider(),
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(memory().store));
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
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(memory().store));
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
			host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(memory().store));
		const repo = await host.ensure("repo", "owned");
		expect(await host.remove("repo", repo.id)).toBe(false);
		p.infos.delete("ns-team-repo");
		expect(await host.remove("repo", repo.id)).toBe(true);
		expect(p.remove).toHaveBeenCalledTimes(1);
	});
});

describe("durable provider repository identity", () => {
	it("never adopts an unrecorded existing name after losing the creation response", async () => {
		const p = provider(),
			{ store } = memory();
		const host = () => new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(store));
		const create = p.create.getMockImplementation()!;
		p.create.mockImplementationOnce(async (...args) => {
			await create(...args);
			throw new Error("creation response lost before ID was recorded");
		});
		await expect(host().ensure("canonical", "owned")).rejects.toThrow("retry");
		p.infos.get("ns-team-canonical")!.id = "replacement";
		await expect(host().ensure("canonical", "owned")).rejects.toThrow("identity unavailable");
		await expect(host().withToken("canonical", "read", vi.fn())).rejects.toThrow("identity unavailable");
		expect(p.create).toHaveBeenCalledTimes(1);
		expect(p.createToken).not.toHaveBeenCalled();
		expect(p.revokeToken).not.toHaveBeenCalled();
		expect(new ProviderIdentity(store).expected("canonical")).toBeUndefined();
	});
	it.each(["canonical", "source", "evidence", "fork"])(
		"pins %s before interrupted cleanup and rejects a replacement after restart",
		async (name) => {
			const p = provider(),
				{ store } = memory();
			const host = () => new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(store));
			const run = () => (name === "fork" ? host().fork("canonical", name, "owned") : host().ensure(name, "owned"));
			if (name === "fork") await host().ensure("canonical", "owned");
			p.revokeToken.mockRejectedValueOnce(new Error("cleanup response lost"));
			await expect(run()).rejects.toThrow("retry");
			const physical = `ns-team-${name}`,
				original = { ...p.infos.get(physical)! };
			expect(new ProviderIdentity(store).expected(name)).toBe(original.id);
			p.infos.set(physical, { ...original, id: "recreated-provider-id" });
			const creates = p.create.mock.calls.length,
				revocations = p.revokeToken.mock.calls.length;
			const source = vi.fn();
			await expect(run()).rejects.toThrow("identity changed");
			await expect(host().withToken(name, "read", source)).rejects.toThrow("identity changed");
			await expect(
				host().gitRequest(name, new Request("https://cruce.test/info/refs?service=git-upload-pack"), original.id),
			).rejects.toThrow("identity changed");
			await expect(host().remove(name, original.id)).rejects.toThrow("identity changed");
			expect(source).not.toHaveBeenCalled();
			expect(p.createToken).not.toHaveBeenCalled();
			expect(p.remove).not.toHaveBeenCalled();
			expect(p.create).toHaveBeenCalledTimes(creates);
			expect(p.revokeToken).toHaveBeenCalledTimes(revocations);
			expect(new ProviderIdentity(store).expected(name)).toBe(original.id);
			p.infos.set(physical, original);
			expect(await run()).toMatchObject({ id: original.id, created: false });
		},
	);
	it("validates the canonical parent even when replaying an existing fork", async () => {
		const p = provider(),
			{ store } = memory();
		const host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(store));
		await host.ensure("canonical", "owned");
		await host.fork("canonical", "fork", "workspace");
		p.infos.get("ns-team-canonical")!.id = "replacement";
		const revocations = p.revokeToken.mock.calls.length;
		await expect(host.fork("canonical", "fork", "workspace")).rejects.toThrow("identity changed");
		await expect(host.fork("canonical", "new-fork", "workspace")).rejects.toThrow("identity changed");
		expect(p.fork).toHaveBeenCalledTimes(1);
		expect(p.revokeToken).toHaveBeenCalledTimes(revocations);
	});
	it("never recreates a missing recorded repository and retains its ID after confirmed deletion", async () => {
		const p = provider(),
			{ store } = memory();
		const host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(store));
		const canonical = await host.ensure("canonical", "owned");
		const fork = await host.fork("canonical", "fork", "workspace");
		p.infos.delete("ns-team-fork");
		expect(await host.remove("fork", fork.id)).toBe(true);
		await expect(host.fork("canonical", "fork", "workspace")).rejects.toThrow("missing");
		p.infos.delete("ns-team-canonical");
		await expect(host.ensure("canonical", "owned")).rejects.toThrow("missing");
		expect(new ProviderIdentity(store).expected("canonical")).toBe(canonical.id);
		expect(new ProviderIdentity(store).expected("fork")).toBe(fork.id);
		expect(p.create).toHaveBeenCalledTimes(2);
	});
	it("checks a fresh handle again before token issuance, including installation addresses", async () => {
		const p = provider(),
			{ store } = memory();
		const host = new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "team", new ProviderIdentity(store));
		await host.ensure("canonical", "owned");
		await host.info("canonical");
		p.infos.get("ns-team-canonical")!.remote = `https://${ACCOUNT}.artifacts.cloudflare.net/git/other/ns-team-canonical.git`;
		await expect(host.withToken("canonical", "write", vi.fn())).rejects.toThrow("account mismatch");
		expect(p.createToken).not.toHaveBeenCalled();
	});
});
