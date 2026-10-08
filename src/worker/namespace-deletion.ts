import { DomainError, domainStatus, publicError, stable } from "../core/errors.ts";
import type { NamespaceController } from "../core/ownership.ts";
import { repositoryOwner } from "../core/repository-lifecycle.ts";
import type { Namespace, Repository, ResourceStorage } from "../shared/platform.ts";
import type { ConnectionGrant } from "./namespace-runtime.ts";
import type { Store } from "./store.ts";

export interface NamespaceDeletionPort {
	/** A fresh controller over current namespace state; repository deletions update it while this runs. */
	load(): NamespaceController;
	save(c: NamespaceController, entries?: { key: string; value: unknown }[]): void;
	/** Starts or resumes one repository's own permanent deletion under the owner's console grant. */
	deleteRepository(
		repository: Repository,
		idempotencyKey: string,
		grant: ConnectionGrant,
		forgetStorage: boolean,
	): Promise<{ state: string; reason?: string; blocked?: boolean }>;
	/** Read-only storage readiness of the namespace; never binds or calls the provider. */
	storage(): ResourceStorage;
	/** Whatever stops deleting the namespace's repositories, each naming its repository. */
	blockers(grant: ConnectionGrant): Promise<string[]>;
	/** Removes the namespace from discovery and frees its handle. Idempotent. */
	retire(namespace: Namespace, members: string[]): Promise<unknown>;
	schedule(at: number): Promise<void>;
}
type Input = { confirmation: string; idempotencyKey: string; forgetStorage?: true };
interface Deletion {
	input: Input;
	grant: ConnectionGrant;
	fingerprint: string;
	phase: "repositories" | "directory" | "complete";
	state: "pending" | "blocked" | "complete";
	/** The last repository attempted, so bounded attempts take turns across all of them. */
	cursor?: string;
	reason?: string;
	repository?: string;
	nextAttempt?: number;
}
const deletionKey = "namespace-deletion";
/** Repository deletions started or resumed per attempt; each continues on its own alarm in between. */
const BATCH = 4;
export class NamespaceDeletionRuntime {
	constructor(
		readonly store: Store,
		readonly port: NamespaceDeletionPort,
		readonly now: () => number,
	) {}
	view() {
		const deletion = this.store.get<Deletion>(deletionKey);
		if (!deletion || deletion.phase === "complete") return;
		return {
			idempotencyKey: deletion.input.idempotencyKey,
			...(deletion.input.forgetStorage ? { forgetStorage: true as const } : {}),
			...(deletion.reason ? { reason: deletion.repository ? `${deletion.repository}: ${deletion.reason}` : deletion.reason } : {}),
		};
	}
	async command(grant: ConnectionGrant, input: Input) {
		const c = this.port.load();
		const a = c.authority(grant.actor);
		repositoryOwner(a);
		const fingerprint = stable({ input, actorId: grant.actor.id });
		const existing = this.store.get<Deletion>(deletionKey);
		if (existing) {
			if (existing.fingerprint !== fingerprint) throw new DomainError(409, "Resume the existing namespace deletion");
			existing.state = "pending";
			return this.advance(existing);
		}
		if (c.state.namespace.kind !== "shared")
			throw new DomainError(409, "A personal namespace belongs to its account; delete its repositories instead");
		if (input.confirmation !== c.state.namespace.handle) throw new DomainError(400, "Type the namespace handle to confirm deletion");
		// Legacy storage cannot be reached, so its repositories can only be forgotten, and only with the owner's confirmation.
		const storage = this.port.storage();
		const forget = !storage.ready && Boolean(storage.legacy) && this.live().length > 0;
		if (Boolean(input.forgetStorage) !== forget)
			throw new DomainError(
				409,
				forget
					? "Confirm that Cruce will not delete this namespace's legacy storage"
					: "Storage is reachable; delete without forgetting it",
			);
		if ((await this.port.blockers(grant)).length) throw new DomainError(409, "Namespace deletion has blockers");
		const deletion: Deletion = {
			input,
			grant: { actor: grant.actor, continuation: { kind: "console" } },
			fingerprint,
			phase: "repositories",
			state: "pending",
		};
		// Blockers were read across repositories; reload so the freeze applies to current state.
		const current = this.port.load();
		current.deletion(current.authority(grant.actor), {
			state: "deleting",
			at: this.now(),
			actorId: grant.actor.id,
			operationId: input.idempotencyKey,
		});
		await this.port.schedule(this.now() + 30_000);
		this.port.save(current, [{ key: deletionKey, value: deletion }]);
		return this.advance(deletion);
	}
	private async advance(deletion: Deletion) {
		if (deletion.phase === "complete") return { state: "deleted" };
		try {
			repositoryOwner(this.port.load().authority(deletion.grant.actor));
			await this.port.schedule(this.now() + 30_000);
			deletion.reason = deletion.repository = undefined;
			if (deletion.phase === "repositories") {
				const live = this.live();
				const after = live.filter((r) => !deletion.cursor || r.id > deletion.cursor);
				for (const repository of [...after, ...live.filter((r) => !after.includes(r))].slice(0, BATCH)) {
					// A repository whose deletion its owner already started resumes under that operation.
					const key =
						repository.lifecycle?.state === "deleting"
							? repository.lifecycle.operationId
							: `${deletion.input.idempotencyKey}:${repository.id}`;
					let result: Awaited<ReturnType<NamespaceDeletionPort["deleteRepository"]>>;
					try {
						result = await this.port.deleteRepository(repository, key, deletion.grant, Boolean(deletion.input.forgetStorage));
					} catch (error) {
						deletion.repository = repository.name;
						throw error;
					}
					if (result.reason) {
						deletion.repository = repository.name;
						deletion.reason = result.reason;
						if (result.blocked) throw new DomainError(409, result.reason);
					}
					deletion.cursor = repository.id;
					this.store.put(deletionKey, deletion);
				}
				if (this.live().length) return this.pending(deletion);
				deletion.phase = "directory";
				this.store.put(deletionKey, deletion);
			}
			const c = this.port.load();
			await this.port.retire(c.state.namespace, Object.keys(c.state.members));
			c.deletion(c.authority(deletion.grant.actor), {
				state: "deleted",
				at: this.now(),
				actorId: deletion.grant.actor.id,
				operationId: deletion.input.idempotencyKey,
			});
			Object.assign(deletion, { phase: "complete", state: "complete", reason: undefined, repository: undefined, nextAttempt: undefined });
			this.port.save(c, [{ key: deletionKey, value: deletion }]);
			return { state: "deleted" };
		} catch (error) {
			const status = domainStatus(error) ?? 0;
			// A repository's blocked deletion already published its reason; anything else is published here.
			if (!(status === 409 && deletion.reason === (error as Error).message)) deletion.reason = publicError(error).message;
			deletion.state = [401, 403, 409, 410, 413].includes(status) ? "blocked" : "pending";
			deletion.nextAttempt = deletion.state === "pending" ? this.now() + 30_000 : undefined;
			this.store.put(deletionKey, deletion);
			return { state: "deleting", reason: this.view()?.reason };
		}
	}
	private live() {
		return this.port
			.load()
			.state.repositories.filter((r) => r.lifecycle?.state !== "deleted")
			.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}
	private pending(deletion: Deletion) {
		deletion.nextAttempt = this.now() + 30_000;
		this.store.put(deletionKey, deletion);
		return { state: "deleting", reason: this.view()?.reason };
	}
	async recover() {
		const deletion = this.store.get<Deletion>(deletionKey);
		if (deletion?.state !== "pending" || deletion.phase === "complete") return;
		if ((deletion.nextAttempt ?? 0) > this.now()) await this.port.schedule(deletion.nextAttempt!);
		else await this.advance(deletion);
	}
}
