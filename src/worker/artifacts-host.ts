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

	/** Fork `source` into `target` (one isolated repository per Flight). */
	async fork(source: string, target: string, description: string): Promise<RepoRef> {
		if (await this.exists(target)) {
			using existing = await this.binding.get(target);
			const info = await existing.info();
			return { name: info.name, id: info.id, remote: info.remote, created: false };
		}
		using repo = await this.binding.get(source);
		const forked = await repo.fork(target, { description, defaultBranchOnly: true, readOnly: false });
		await this.revoke(target, forked.token);
		return { name: forked.name, id: forked.id, remote: forked.remote, created: true };
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
		await this.revoke(name, id);
	}

	async info(name: string) {
		using repo = await this.binding.get(name);
		return repo.info();
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
