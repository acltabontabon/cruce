/**
 * Thin wrapper over the Artifacts Workers binding with Cruce's credential discipline:
 * - tokens returned by `create()` (≈1 year) and `fork()` (24h) are revoked immediately;
 * - every Git operation uses a freshly minted token with the shortest TTL (60s) and revokes it after.
 */

export interface RepoRef {
	name: string;
	id: string;
	remote: string;
	created: boolean;
}

export class ArtifactsHost {
	constructor(
		private readonly binding: Artifacts,
		readonly namespace: string,
	) {}

	async exists(name: string): Promise<boolean> {
		try {
			using repo = await this.binding.get(name);
			await repo.info();
			return true;
		} catch (e) {
			if (isNotFound(e)) return false;
			throw e;
		}
	}

	async ensure(name: string, description: string): Promise<RepoRef> {
		try {
			using repo = await this.binding.get(name);
			const info = await repo.info();
			return { name: info.name, id: info.id, remote: info.remote, created: false };
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
		const created = await this.binding.create(name, { description, setDefaultBranch: "main" });
		await this.revoke(name, created.token);
		return { name: created.name, id: created.id, remote: created.remote, created: true };
	}

	/**
	 * Fork `source` into `target` (one isolated repository per Flight). Forks complete asynchronously,
	 * so this waits until the new repository is ready before returning.
	 */
	async fork(source: string, target: string, description: string): Promise<RepoRef> {
		for (let attempt = 0; attempt < 10; attempt++) {
			const ready = await this.readyInfo(target);
			if (ready) {
				if (ready.description !== description || ready.source !== `artifacts:${this.namespace}/${source}`)
					throw new Error("Flight repository ownership mismatch");
				return { name: ready.name, id: ready.id, remote: ready.remote, created: attempt > 0 };
			}
			try {
				using repo = await this.binding.get(source);
				const forked = await repo.fork(target, { description, defaultBranchOnly: true, readOnly: false });
				await this.revoke(target, forked.token);
				const info = await this.waitReady(target);
				return { name: forked.name, id: forked.id, remote: info?.remote ?? forked.remote, created: true };
			} catch (e) {
				const msg = String((e as Error)?.message ?? e);
				// In progress, or the name is still held by a deletion that has not propagated: wait and retry.
				if (!/in progress|being forked|already exists|ALREADY_EXISTS|FORK_IN_PROGRESS|not yet available/i.test(msg)) throw e;
				await sleep(2500);
			}
		}
		throw new Error(`fork of ${source} into ${target} did not become ready`);
	}

	private async readyInfo(name: string) {
		try {
			using repo = await this.binding.get(name);
			return await repo.info();
		} catch {
			return undefined;
		}
	}

	private async waitReady(name: string) {
		for (let i = 0; i < 15; i++) {
			const info = await this.readyInfo(name);
			if (info) return info;
			await sleep(1000);
		}
		return undefined;
	}

	/** Run `fn` with a short-lived repo token, revoking it afterwards no matter what. */
	async withToken<T>(name: string, scope: "read" | "write", fn: (token: string) => Promise<T>): Promise<{ result: T; tokenId: string }> {
		using repo = await this.binding.get(name);
		const token = await repo.createToken(scope, 60);
		try {
			return { result: await fn(token.plaintext), tokenId: token.id };
		} finally {
			await repo.revokeToken(token.id).catch(() => false);
		}
	}

	/** A token kept by Cruce (e.g. the read token the sandbox egress injects); revoke it when done. */
	async mint(name: string, scope: "read" | "write", ttlSeconds: number) {
		using repo = await this.binding.get(name);
		return repo.createToken(scope, ttlSeconds);
	}

	async revokeToken(name: string, id: string) {
		using repo = await this.binding.get(name);
		await repo.revokeToken(id);
	}

	/** Revoke every active token on a repository (used when a Flight finishes). */
	async revokeAll(name: string): Promise<number> {
		using repo = await this.binding.get(name);
		const { tokens } = await repo.listTokens();
		let revoked = 0;
		for (const t of tokens) {
			if (t.state !== "active") continue;
			if (await repo.revokeToken(t.id)) revoked++;
		}
		return revoked;
	}

	async info(name: string) {
		using repo = await this.binding.get(name);
		return repo.info();
	}

	async find(name: string) {
		try {
			return await this.info(name);
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	list(cursor?: string) {
		return this.binding.list({ limit: 100, cursor });
	}

	async readFile(name: string, ref: string, path: string) {
		using repo = await this.binding.get(name);
		return repo.readFile({ ref, path });
	}

	async log(name: string, ref = "main", limit = 30) {
		using repo = await this.binding.get(name);
		return repo.log({ ref, limit });
	}

	async delete(name: string): Promise<boolean> {
		try {
			return await this.binding.delete(name);
		} catch (e) {
			if (isNotFound(e)) return false;
			throw e;
		}
	}

	private async revoke(name: string, tokenOrId: string) {
		try {
			using repo = await this.binding.get(name);
			await repo.revokeToken(tokenOrId);
		} catch {
			// The token expires on its own; revocation is defence in depth.
		}
	}
}

function isNotFound(e: unknown): boolean {
	const code = (e as { code?: string })?.code;
	const message = String((e as Error)?.message ?? e);
	return code === "NOT_FOUND" || /not[ _]found|does not exist|NOT_FOUND/i.test(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
