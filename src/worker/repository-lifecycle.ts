import { DomainError, domainStatus, publicError, stable } from "../core/errors.ts";
import { initialRepository } from "../core/platform.ts";
import { repositoryLifecycleView, repositoryOwner } from "../core/repository-lifecycle.ts";
import type { Authority, Command, Repository, RepositoryState, ResourceReservation } from "../shared/platform.ts";
import type { RepositoryHost } from "./artifacts.ts";
import type { ConnectionGrant } from "./namespace-runtime.ts";
import { hash, type Store, someRecord } from "./store.ts";

export interface LifecyclePort {
	authority(grant: ConnectionGrant, repositoryId: string): Authority | Promise<Authority>;
	lifecycle(grant: ConnectionGrant, repositoryId: string, lifecycle: NonNullable<Repository["lifecycle"]>): unknown | Promise<unknown>;
	lifecycleReservations(
		grant: ConnectionGrant,
		repositoryId: string,
		operationId?: string,
	): ResourceReservation[] | Promise<ResourceReservation[]>;
	releaseReservation(grant: ConnectionGrant, repositoryId: string, id: string): unknown;
	reserve(
		grant: ConnectionGrant,
		repositoryId: string,
		id: string,
		fingerprint: string,
		action: "repository.delete",
		storageRequired?: boolean,
	): Promise<{ id: string }>;
	settle(id: string, state: "complete" | "uncertain"): unknown | Promise<unknown>;
	host(): Promise<RepositoryHost>;
	schedule(at: number): Promise<void>;
	resetCache(): void;
}
interface Deletion {
	command: Command;
	grant: ConnectionGrant;
	fingerprint: string;
	reservationId?: string;
	cursor?: string;
	canonicalConfirmed?: boolean;
	hasResources: boolean;
	phase: "authorized" | "deleting" | "confirmed" | "purging" | "complete";
	state: "pending" | "blocked" | "complete";
	reason?: string;
	nextAttempt?: number;
}
const deletionKey = "repository-deletion";
const transitionKey = "repository-transition";
export class RepositoryLifecycleRuntime {
	constructor(
		readonly store: Store,
		readonly port: LifecyclePort,
		readonly now: () => number,
	) {}
	private state(repository: Repository) {
		return this.store.get<RepositoryState>("repository") ?? initialRepository(repository);
	}
	async view(repository: Repository, grant: ConnectionGrant, a: Authority) {
		const deletion = this.store.get<Deletion>(deletionKey);
		const state = this.state(repository);
		const pendingTransition = this.store.get<string>(transitionKey);
		const transition = pendingTransition && this.store.get<{ lifecycle: NonNullable<Repository["lifecycle"]> }>(pendingTransition);
		state.repository = { ...repository, lifecycle: state.repository.lifecycle ?? repository.lifecycle };
		const pending = await this.port.lifecycleReservations(grant, repository.id, deletion?.reservationId);
		const view = repositoryLifecycleView(state, a, pending.length > 0);
		if (pending.length)
			view.operations = pending.map((r) => ({
				id: r.id,
				action: r.action,
				state: r.state as "reserved" | "uncertain",
				at: r.at,
				...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
			}));
		if (
			this.store.get<{ enabled: boolean }>("observation-config")?.enabled ||
			someRecord<{ removed?: boolean; operation?: unknown }>(
				this.store,
				"observation-target:",
				(target) => !target.removed || Boolean(target.operation),
			)
		)
			for (const list of [view.blockers, view.deletionBlockers]) list.push("Disable push observation and finish subscription cleanup.");
		if (transition && view.owner)
			view.transition = {
				tool: transition.lifecycle.state === "archived" ? "archive_repository" : "restore_repository",
				idempotencyKey: transition.lifecycle.operationId,
			};
		if (deletion && deletion.phase !== "complete") {
			view.state = "deleting";
			view.deletion = { idempotencyKey: deletion.command.idempotencyKey!, reason: deletion.reason };
		}
		return view;
	}
	async command(repository: Repository, command: Command, grant: ConnectionGrant) {
		const a = await this.port.authority(grant, repository.id);
		repositoryOwner(a);
		if (command.tool === "release_resource_operation") {
			if (Object.keys(command).some((key) => !["tool", "namespaceId", "repositoryId", "idempotencyKey", "reservationId"].includes(key)))
				throw new DomainError(400, "Unsupported repository lifecycle input");
			if (this.store.get(deletionKey)) throw new DomainError(409, "Resume the existing repository deletion");
			await this.port.releaseReservation(grant, repository.id, requireReservation(command.reservationId));
			return this.view(repository, grant, a);
		}
		if (Object.keys(command).some((key) => !["tool", "namespaceId", "repositoryId", "idempotencyKey", "confirmation"].includes(key)))
			throw new DomainError(400, "Unsupported repository lifecycle input");
		if (!command.idempotencyKey) throw new DomainError(400, "Mutation requires an idempotency key");
		const fingerprint = stable({ command, actorId: grant.actor.id });
		const operation = await hash(`${grant.actor.id}:${command.idempotencyKey}`);
		const commandFingerprint = await hash(stable(command));
		const receipt = this.store.get<{ fingerprint: string }>(`receipt:${operation}`);
		if (receipt && receipt.fingerprint !== commandFingerprint && receipt.fingerprint !== stable(command))
			throw new DomainError(409, "Operation identity reused");
		const deletion = this.store.get<Deletion>(deletionKey);
		if (deletion) {
			if (command.tool !== "delete_repository" || deletion.fingerprint !== fingerprint)
				throw new DomainError(409, "Resume the existing repository deletion");
			deletion.state = "pending";
			return this.remove(repository, deletion);
		}
		const receiptKey = `repository-transition:${operation}`;
		const previous = this.store.get<{ fingerprint: string }>(receiptKey);
		if (previous && previous.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
		const transition = this.store.get<{ fingerprint: string; lifecycle: NonNullable<Repository["lifecycle"]>; synced: boolean }>(
			receiptKey,
		);
		if (transition?.fingerprint === fingerprint) {
			if (!transition.synced) {
				await this.port.lifecycle(grant, repository.id, transition.lifecycle);
				this.store.batch(
					[
						{ key: receiptKey, value: { ...transition, synced: true } },
						{ key: `receipt:${operation}`, value: { fingerprint: commandFingerprint, result: transition.lifecycle } },
					],
					[transitionKey],
				);
			}
			return transition.lifecycle;
		}
		if (this.store.get(transitionKey)) throw new DomainError(409, "Retry the unfinished repository transition");
		const view = await this.view(repository, grant, a);
		if (view.state === "deleted" || view.state === "deleting") throw new DomainError(409, "Repository deletion is already authorized");
		const blockers = command.tool === "delete_repository" ? view.deletionBlockers : view.blockers;
		if (command.tool !== "restore_repository" && blockers.length) throw new DomainError(409, "Repository retirement has blockers");
		if (command.tool === "delete_repository") {
			if (command.confirmation !== repository.name) throw new DomainError(400, "Type the repository name to confirm deletion");
			// Inventory includes source/evidence stores and identities preserved when finished work was archived.
			const state = this.state(repository);
			const identities = [
				...(state.canonical ? [{ name: state.canonical.name, id: state.canonical.id }] : []),
				...state.workspaces.flatMap((w) => (w.fork ? [{ name: w.fork.name, id: w.fork.id }] : [])),
				...state.artifacts.map((artifact) => ({ name: artifact.storage.repository, id: artifact.storage.providerId })),
			];
			for (const identity of identities) {
				if (!identity.id) throw new DomainError(409, "Provider repository identity unavailable");
				const key = `provider-repository:${identity.name}`;
				const old = this.store.get<string>(key);
				if (old && old !== identity.id) throw new DomainError(409, "Recorded provider repository identities disagree");
				if (!old) this.store.put(key, identity.id);
			}
			const intent: Deletion = {
				command,
				grant: { actor: grant.actor, continuation: { kind: "console" } },
				fingerprint,
				phase: "authorized",
				state: "pending",
				hasResources: this.store.scan("provider-repository:", undefined, 1).length > 0,
			};
			await this.port.schedule(this.now() + 30_000);
			this.store.put(deletionKey, intent);
			return this.remove(repository, intent);
		}
		this.store.admit(8192, 4);
		const lifecycle: NonNullable<Repository["lifecycle"]> = {
			state: command.tool === "archive_repository" ? "archived" : "active",
			at: this.now(),
			actorId: a.actor.id,
			operationId: command.idempotencyKey,
		};
		const state = this.state(repository);
		state.repository = { ...repository, lifecycle };
		this.store.batch([
			{ key: "repository", value: state },
			{ key: transitionKey, value: receiptKey },
			{ key: receiptKey, value: { fingerprint, lifecycle, synced: false } },
		]);
		await this.port.lifecycle(grant, repository.id, lifecycle);
		this.store.batch(
			[
				{ key: receiptKey, value: { fingerprint, lifecycle, synced: true } },
				{ key: `receipt:${operation}`, value: { fingerprint: commandFingerprint, result: lifecycle } },
			],
			[transitionKey],
		);
		return lifecycle;
	}
	private async remove(repository: Repository, deletion: Deletion) {
		try {
			repositoryOwner(await this.port.authority(deletion.grant, repository.id));
			if (deletion.phase === "complete") return { state: "deleted" };
			await this.port.schedule(this.now() + 30_000);
			const reservation = await this.port.reserve(
				deletion.grant,
				repository.id,
				deletion.command.idempotencyKey!,
				stable(deletion.command),
				"repository.delete",
				deletion.hasResources,
			);
			deletion.reservationId = reservation.id;
			const lifecycle: NonNullable<Repository["lifecycle"]> = {
				state: "deleting",
				at: this.now(),
				actorId: deletion.grant.actor.id,
				operationId: deletion.command.idempotencyKey!,
			};
			const state = this.state(repository);
			state.repository = { ...repository, lifecycle };
			this.store.batch([
				{ key: deletionKey, value: deletion },
				{ key: "repository", value: state },
			]);
			await this.port.lifecycle(deletion.grant, repository.id, lifecycle);
			if (["authorized", "deleting"].includes(deletion.phase)) {
				deletion.phase = "deleting";
				this.store.put(deletionKey, deletion);
				const rows = this.store.scan<string>("provider-repository:", deletion.cursor, 4);
				// Provider deletion is asynchronous: request the whole batch, then confirm absence on the next attempt.
				// The cursor only passes repositories confirmed absent, so a later attempt rechecks the rest.
				let confirmed = true;
				for (const row of rows) {
					const name = row.key.slice("provider-repository:".length);
					if (name !== repository.storageName) {
						// Recheck current owner authority, policy and installation identity before every effect.
						repositoryOwner(await this.port.authority(deletion.grant, repository.id));
						await this.port.reserve(
							deletion.grant,
							repository.id,
							deletion.command.idempotencyKey!,
							stable(deletion.command),
							"repository.delete",
							deletion.hasResources,
						);
						if (!row.value) throw new DomainError(409, "Provider repository identity unavailable");
						if (!(await (await this.port.host()).remove(name, row.value))) confirmed = false;
					}
					if (!confirmed) continue;
					deletion.cursor = row.key;
					this.store.put(deletionKey, deletion);
				}
				if (!confirmed || rows.length === 4) return this.pending(deletion);
				const canonicalId = this.store.get<string>(`provider-repository:${repository.storageName}`);
				if (canonicalId && !deletion.canonicalConfirmed) {
					repositoryOwner(await this.port.authority(deletion.grant, repository.id));
					await this.port.reserve(
						deletion.grant,
						repository.id,
						deletion.command.idempotencyKey!,
						stable(deletion.command),
						"repository.delete",
						deletion.hasResources,
					);
					if (!(await (await this.port.host()).remove(repository.storageName, canonicalId))) return this.pending(deletion);
					deletion.canonicalConfirmed = true;
				}
				deletion.phase = "confirmed";
				this.store.put(deletionKey, deletion);
			}
			if (deletion.phase === "confirmed") {
				await this.port.settle(reservation.id, "complete");
				deletion.phase = "purging";
				this.store.put(deletionKey, deletion);
			}
			// Preserve only a deletion receipt and minimal tombstone. Partial purge is replayable.
			const keys = this.store
				.scan("", undefined, 104)
				.map((r) => r.key)
				.filter((key) => key !== deletionKey && key !== "repository");
			if (keys.length) this.store.batch([], keys);
			if (keys.length >= 100) return this.pending(deletion);
			this.port.resetCache();
			lifecycle.state = "deleted";
			await this.port.lifecycle(deletion.grant, repository.id, lifecycle);
			deletion.phase = "complete";
			deletion.state = "complete";
			deletion.reason = undefined;
			this.store.batch([
				{ key: deletionKey, value: deletion },
				{
					key: "repository",
					value: initialRepository({
						...repository,
						grants: [],
						policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
						lifecycle,
					}),
				},
			]);
			return { state: "deleted" };
		} catch (error) {
			deletion.reason = publicError(error).message;
			deletion.state = [401, 403, 409, 413].includes(domainStatus(error) ?? 0) ? "blocked" : "pending";
			deletion.nextAttempt = deletion.state === "pending" ? this.now() + 30_000 : undefined;
			this.store.put(deletionKey, deletion);
			if (deletion.reservationId && !["confirmed", "purging", "complete"].includes(deletion.phase))
				await this.port.settle(deletion.reservationId, "uncertain");
			return { state: "deleting", reason: deletion.reason };
		}
	}
	private pending(deletion: Deletion) {
		deletion.nextAttempt = this.now() + 30_000;
		deletion.reason = undefined;
		this.store.put(deletionKey, deletion);
		return { state: "deleting" };
	}
	async recover(repository: Repository) {
		const deletion = this.store.get<Deletion>(deletionKey);
		if (deletion?.state !== "pending" || deletion.phase === "complete") return;
		// The alarm set when an attempt began can fire before that attempt's next time; wake again then rather than stall.
		if ((deletion.nextAttempt ?? 0) > this.now()) await this.port.schedule(deletion.nextAttempt!);
		else await this.remove(repository, deletion);
	}
}
function requireReservation(id: string | undefined) {
	if (!id) throw new DomainError(400, "Choose the operation to release");
	return id;
}
