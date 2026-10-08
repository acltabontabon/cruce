import { DurableObject } from "cloudflare:workers";
import { DEFAULT_RESOURCE_POLICY } from "../core/capabilities.ts";
import { DomainError, stable } from "../core/errors.ts";
import { namespaceDeletionView, type RepositoryRetirement } from "../core/namespace-lifecycle.ts";
import { initialNamespace, NamespaceController } from "../core/ownership.ts";
import { repositoryOwner } from "../core/repository-lifecycle.ts";
import { assertNamespaceCapacity } from "../core/state-limits.ts";
import { STATE_LIMITS } from "../shared/limits.ts";
import {
	type Actor,
	CommandInput,
	type Invitation,
	type Namespace,
	type NamespaceRole,
	type NamespaceState,
	type Repository,
	type RepositoryApproval,
	type RepositorySnapshot,
	type ResourceAction,
	type ResourcePolicy,
	type ResourceReservation,
	type User,
} from "../shared/platform.ts";
import { ResourceBoundary, type StorageEnv } from "./artifacts.ts";
import type { ControlTower } from "./control-tower.ts";
import type { Directory } from "./directory.ts";
import { namespaceDirectory } from "./directory-access.ts";
import { NamespaceDeletionRuntime } from "./namespace-deletion.ts";
import { boundedMap } from "./platform-router.ts";
import { hash, sqlStore } from "./store.ts";
export type ContinuationAuthorization =
	| { kind: "console" }
	| { kind: "oauth"; key: string; propsHash: string }
	| { kind: "terminal"; key: string };
export interface ConnectionGrant {
	actor: Actor;
	scopes?: string[];
	repositories?: RepositoryApproval;
	continuation?: ContinuationAuthorization;
}
interface NamespaceEnv extends StorageEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	DIRECTORY: DurableObjectNamespace<Directory>;
}
export class NamespaceRuntime extends DurableObject<NamespaceEnv> {
	private store = sqlStore(this.ctx.storage.sql, (run) => this.ctx.storage.transactionSync(run));
	private deletion() {
		return new NamespaceDeletionRuntime(
			this.store,
			{
				load: () => this.controller(),
				save: (c, entries) => this.save(c, entries),
				deleteRepository: async (repository, idempotencyKey, grant) =>
					(await this.env.CONTROL_TOWER.getByName(repository.id).command(
						repository,
						CommandInput.parse({
							tool: "delete_repository",
							namespaceId: repository.namespaceId,
							repositoryId: repository.id,
							idempotencyKey,
							confirmation: repository.name,
						}),
						grant,
					)) as { state: string; reason?: string; blocked?: boolean },
				blockers: async (grant) => {
					const c = this.controller();
					return namespaceDeletionView(
						c.state,
						c.authority(grant.actor),
						await this.retirements(grant),
						new ResourceBoundary(this.store, this.env, { namespace: c.state.namespace.id }).storage(),
					).blockers;
				},
				retire: (namespace, members) => namespaceDirectory(this.env).retire(namespace.id, members),
				schedule: async (at) => {
					const current = await this.ctx.storage.getAlarm();
					if (current === null || current > at) await this.ctx.storage.setAlarm(at);
				},
			},
			Date.now,
		);
	}
	/** Each live repository with its own lifecycle view, read as the given grant; unreadable ones have none. */
	private async retirements(grant: ConnectionGrant): Promise<RepositoryRetirement[]> {
		const repositories = this.controller().state.repositories.filter((r) => r.lifecycle?.state !== "deleted");
		const results = await boundedMap(
			repositories,
			async (repository) =>
				(
					(await this.env.CONTROL_TOWER.getByName(repository.id).command(
						repository,
						{ tool: "get_repository", namespaceId: repository.namespaceId, repositoryId: repository.id },
						grant,
					)) as RepositorySnapshot
				).lifecycle,
		);
		return repositories.map((repository, i) => ({
			repository,
			lifecycle: results[i].status === "fulfilled" ? results[i].value : undefined,
		}));
	}
	async alarm() {
		await this.deletion().recover();
	}
	/** The console owner's permanent deletion of this shared namespace and every repository in it. */
	deleteNamespace(grant: ConnectionGrant, input: { confirmation: string; idempotencyKey: string }) {
		return this.deletion().command(grant, input);
	}
	private controller(repositoryId?: string) {
		const state = this.store.get<NamespaceState>("namespace");
		if (!state) throw new DomainError(404, "Namespace unavailable");
		if (repositoryId && !state.repositories.some((r) => r.id === repositoryId)) {
			const deleted = this.store.get<Repository>(`deleted-repository:${repositoryId}`);
			if (deleted) state.repositories.push(deleted);
		}
		state.reservations = state.reservations.map(
			(reservation) => this.store.get<ResourceReservation>(this.reservationKey(reservation.id)) ?? reservation,
		);
		return new NamespaceController(state, Date.now());
	}
	initialize(namespace: Namespace) {
		const old = this.store.get<NamespaceState>("namespace");
		if (!old) this.store.put("namespace", initialNamespace(namespace));
		else if (old.namespace.id !== namespace.id) throw new DomainError(409, "Namespace identity mismatch");
	}
	metadata(namespace: Namespace) {
		const c = this.controller();
		if (c.state.namespace.id !== namespace.id) throw new DomainError(403, "Namespace mismatch");
		if (c.state.lifecycle) throw new DomainError(409, "Namespace is being deleted");
		c.state.namespace = namespace;
		this.save(c);
	}
	private save(c: NamespaceController, extra: { key: string; value: unknown }[] = []) {
		const repositories = c.state.repositories.filter((r) => r.lifecycle?.state !== "deleted");
		assertNamespaceCapacity({ ...c.state, repositories, reservations: [] });
		const entries: { key: string; value: unknown }[] = c.state.reservations.map((reservation) => ({
			key: this.reservationKey(reservation.id),
			value: reservation,
		}));
		this.store.batch([
			...entries,
			...c.state.repositories
				.filter((r) => r.lifecycle?.state === "deleted")
				.map((value) => ({ key: `deleted-repository:${value.id}`, value })),
			{ key: "namespace", value: { ...c.state, repositories, reservations: [] } },
			...extra,
		]);
	}
	private reservationKey(id: string) {
		return `reservation:${id}`;
	}
	reservations(grant: ConnectionGrant, cursor?: string) {
		const c = this.controller();
		const a = c.authority(grant.actor);
		if (a.actor.kind !== "human" || !["owner", "maintainer"].includes(a.role))
			throw new DomainError(403, "Human namespace maintainer required");
		const after = cursor ? `reservation:${cursor}` : "reservation:";
		const indexed = this.store.scan<ResourceReservation>("reservation:", after, STATE_LIMITS.pageSize + 1);
		const legacy = c.state.reservations.map((value) => ({ key: this.reservationKey(value.id), value })).filter(({ key }) => key > after);
		const rows = [...new Map([...legacy, ...indexed].map((row) => [row.key, row])).values()]
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
			.slice(0, STATE_LIMITS.pageSize + 1);
		return {
			items: rows.slice(0, STATE_LIMITS.pageSize).map(({ value }) => value),
			cursor: rows.length > STATE_LIMITS.pageSize ? rows[STATE_LIMITS.pageSize - 1].key.slice("reservation:".length) : undefined,
		};
	}
	authority(grant: ConnectionGrant, repositoryId?: string) {
		return this.controller(repositoryId).authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
	}
	snapshot(grant: ConnectionGrant) {
		const c = this.controller(),
			a = c.authority(grant.actor),
			maintain = a.actor.kind === "human" && ["owner", "maintainer"].includes(a.role);
		const repositories = c.state.repositories.filter((r) => {
			if (r.lifecycle?.state === "deleted") return false;
			try {
				c.authority(grant.actor, r.id, grant.scopes, grant.repositories);
				return true;
			} catch {
				return false;
			}
		});
		return {
			namespace: c.state.namespace,
			role: a.role,
			repositories,
			members: maintain ? c.state.members : {},
			teams: maintain ? c.state.teams : [],
			policy: { rules: { ...DEFAULT_RESOURCE_POLICY.rules, ...c.state.policy.rules } },
			storage: new ResourceBoundary(this.store, this.env, { namespace: c.state.namespace.id }).storage(),
			reservations: maintain ? this.reservations(grant).items : [],
			capacity: { ...this.store.usage(), limits: STATE_LIMITS },
			permissions: { maintain, owner: maintain && a.role === "owner" },
			lifecycle: c.state.lifecycle,
			deletion: maintain && a.role === "owner" ? this.deletion().view() : undefined,
		};
	}
	repository(grant: ConnectionGrant, repositoryId: string) {
		const c = this.controller(repositoryId);
		c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
		return c.state.repositories.find((r) => r.id === repositoryId)!;
	}
	saveRepository(grant: ConnectionGrant, repository: Repository) {
		const c = this.controller(repository.id);
		c.repository(c.authority(grant.actor), repository);
		this.save(c);
		return repository;
	}
	lifecycle(grant: ConnectionGrant, repositoryId: string, lifecycle: NonNullable<Repository["lifecycle"]>) {
		const c = this.controller(repositoryId);
		c.lifecycle(c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories), lifecycle);
		this.save(c);
	}
	/** Unsettled operations for one repository, oldest first and bounded, so its owner can see what retirement waits for. */
	lifecycleReservations(grant: ConnectionGrant, repositoryId: string, operationId?: string) {
		const c = this.controller(repositoryId);
		c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
		const pending = (r: ResourceReservation) =>
			r.repositoryId === repositoryId && r.id !== operationId && ["reserved", "uncertain"].includes(r.state);
		const found = new Map(c.state.reservations.filter(pending).map((r) => [r.id, r]));
		let cursor: string | undefined;
		for (let offset = 0; offset <= STATE_LIMITS.storeRecords && found.size <= 20; offset += STATE_LIMITS.pageSize) {
			const rows = this.store.scan<ResourceReservation>("reservation:", cursor, STATE_LIMITS.pageSize);
			for (const { value } of rows) if (pending(value)) found.set(value.id, value);
			if (rows.length < STATE_LIMITS.pageSize) break;
			cursor = rows.at(-1)!.key;
		}
		return [...found.values()].toSorted((a, b) => a.at - b.at).slice(0, 20);
	}
	/**
	 * The repository owner's explicit reconciliation of an operation whose outcome Cruce cannot know. It runs, retries
	 * and deletes nothing; a later retry of that operation identity is refused, so it cannot resume behind the decision.
	 */
	releaseReservation(grant: ConnectionGrant, repositoryId: string, id: string) {
		const c = this.controller(repositoryId);
		repositoryOwner(c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories));
		const r = this.store.get<ResourceReservation>(this.reservationKey(id)) ?? c.state.reservations.find((r) => r.id === id);
		if (!r || r.repositoryId !== repositoryId) throw new DomainError(404, "Resource reservation unavailable");
		if (r.action === "repository.delete") throw new DomainError(409, "Resume the repository deletion instead");
		if (!["reserved", "uncertain"].includes(r.state)) return r;
		r.state = "released";
		this.store.put(this.reservationKey(id), r);
		return r;
	}
	/** An operation refused before any provider call performed nothing, so its reservation is released, not uncertain. */
	abandon(id: string) {
		const r = this.store.get<ResourceReservation>(this.reservationKey(id)) ?? this.controller().state.reservations.find((r) => r.id === id);
		if (!r) throw new DomainError(404, "Resource reservation unavailable");
		if (r.state !== "reserved") return;
		r.state = "released";
		this.store.put(this.reservationKey(id), r);
	}
	member(grant: ConnectionGrant, userId: string, role?: NamespaceRole) {
		const c = this.controller();
		c.member(c.authority(grant.actor), userId, role);
		this.save(c);
	}
	team(grant: ConnectionGrant, id: string, name: string, members: string[]) {
		const c = this.controller();
		c.team(c.authority(grant.actor), id, name, members);
		this.save(c);
	}
	invite(grant: ConnectionGrant, invitation: Invitation) {
		const c = this.controller();
		c.invite(c.authority(grant.actor), invitation);
		this.save(c);
	}
	accept(user: User, tokenHash: string) {
		const c = this.controller();
		c.accept(user, tokenHash);
		this.save(c);
	}
	policy(grant: ConnectionGrant, policy: ResourcePolicy) {
		const c = this.controller();
		c.setPolicy(c.authority(grant.actor), policy);
		this.save(c);
	}
	async reserve(
		grant: ConnectionGrant,
		repositoryId: string,
		id: string,
		fingerprint: string,
		action: ResourceAction,
		workspaceId?: string,
		storageRequired = true,
	) {
		const compactFingerprint = await hash(fingerprint);
		const c = this.controller(repositoryId),
			a = c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
		const previous =
			this.store.get<ResourceReservation>(this.reservationKey(`${a.actor.id}:${id}`)) ??
			c.state.reservations.find((r) => r.id === `${a.actor.id}:${id}`);
		if (previous && !c.state.reservations.some((r) => r.id === previous.id)) c.state.reservations.push(previous);
		if (!previous) this.store.admit(8192, 3);
		// Same-domain storage compaction preserves existing operation identities.
		if (previous) {
			const legacy = stable({ fingerprint, action, repositoryId, workspaceId });
			if (previous.fingerprint === legacy)
				previous.fingerprint = stable({ fingerprint: compactFingerprint, action, repositoryId, workspaceId });
		}
		const reservation = c.reserve(a, id, compactFingerprint, action, workspaceId);
		if (storageRequired) new ResourceBoundary(this.store, this.env, { namespace: c.state.namespace.id }).bind();
		this.save(c);
		return reservation;
	}
	settle(id: string, state: "complete" | "uncertain" | "released") {
		const c = this.controller();
		const r = this.store.get<ResourceReservation>(this.reservationKey(id)) ?? c.state.reservations.find((r) => r.id === id);
		if (!r) throw new DomainError(404, "Resource reservation unavailable");
		if (state === "released" && ["reserved", "uncertain"].includes(r.state))
			throw new DomainError(409, "Uncertain resource reservations cannot be released");
		r.state = state;
		this.store.put(this.reservationKey(id), r);
	}
	/** Internal DO RPC only: pinned storage identity, never credentials. */
	resourceConfiguration() {
		return {
			namespace: this.controller().state.namespace.id,
			binding: this.store.get("storage-binding"),
			legacyAccount: Boolean(this.store.get("resource-account")),
			policy: this.controller().state.policy,
		};
	}
}
