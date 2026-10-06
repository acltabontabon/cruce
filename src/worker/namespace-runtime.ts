import { DurableObject } from "cloudflare:workers";
import { DomainError, stable } from "../core/errors.ts";
import { initialNamespace, NamespaceController } from "../core/ownership.ts";
import { assertNamespaceCapacity } from "../core/state-limits.ts";
import { STATE_LIMITS } from "../shared/limits.ts";
import type {
	Actor,
	Invitation,
	Namespace,
	NamespaceRole,
	NamespaceState,
	Repository,
	ResourceAction,
	ResourcePolicy,
	ResourceReservation,
	User,
} from "../shared/platform.ts";
import { ResourceBoundary, type StorageEnv } from "./artifacts.ts";
import { hash, sqlStore } from "./store.ts";
export type ContinuationAuthorization =
	| { kind: "console" }
	| { kind: "oauth"; key: string; propsHash: string }
	| { kind: "terminal"; key: string };
export interface ConnectionGrant {
	actor: Actor;
	scopes?: string[];
	repositories?: string[];
	continuation?: ContinuationAuthorization;
}
export class NamespaceRuntime extends DurableObject<StorageEnv> {
	private store = sqlStore(this.ctx.storage.sql, (run) => this.ctx.storage.transactionSync(run));
	private controller() {
		const state = this.store.get<NamespaceState>("namespace");
		if (!state) throw new DomainError(404, "Namespace unavailable");
		state.reservations = state.reservations.map(
			(reservation) => this.store.get<ResourceReservation>(this.reservationKey(reservation.id)) ?? reservation,
		);
		const now = Date.now(),
			day = Math.floor(now / 86400000);
		const recorded = this.store.get<number>(`budget:${day}`);
		if (recorded !== undefined) state.reservationUsage = { day, used: recorded };
		else if (!state.reservations.length) state.reservationUsage = { day, used: 0 };
		return new NamespaceController(state, now);
	}
	initialize(namespace: Namespace) {
		const old = this.store.get<NamespaceState>("namespace");
		if (!old) this.store.put("namespace", initialNamespace(namespace));
		else if (old.namespace.id !== namespace.id) throw new DomainError(409, "Namespace identity mismatch");
	}
	metadata(namespace: Namespace) {
		const c = this.controller();
		if (c.state.namespace.id !== namespace.id) throw new DomainError(403, "Namespace mismatch");
		c.state.namespace = namespace;
		this.save(c);
	}
	private save(c: NamespaceController) {
		assertNamespaceCapacity({ ...c.state, reservations: [] });
		const entries: { key: string; value: unknown }[] = c.state.reservations.map((reservation) => ({
			key: this.reservationKey(reservation.id),
			value: reservation,
		}));
		const day = Math.floor(c.now / 86400000);
		entries.push({ key: `budget:${day}`, value: c.budget().used });
		this.store.batch([...entries, { key: "namespace", value: { ...c.state, reservations: [], reservationUsage: undefined } }]);
	}
	private reservationKey(id: string) {
		return `reservation:${id}`;
	}
	reservations(grant: ConnectionGrant, cursor?: string) {
		const c = this.controller();
		const a = c.authority(grant.actor);
		if (a.actor.kind !== "human" || !["owner", "maintainer"].includes(a.role)) throw new DomainError(403, "Human maintainer required");
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
		return this.controller().authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
	}
	snapshot(grant: ConnectionGrant) {
		const c = this.controller(),
			a = c.authority(grant.actor),
			maintain = a.actor.kind === "human" && ["owner", "maintainer"].includes(a.role);
		const repositories = c.state.repositories.filter((r) => {
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
			policy: c.state.policy,
			storage: new ResourceBoundary(this.store, this.env, { namespace: c.state.namespace.id }).storage(),
			reservations: maintain ? this.reservations(grant).items : [],
			capacity: { ...this.store.usage(), limits: STATE_LIMITS },
			budget: c.budget(),
			permissions: { maintain, owner: maintain && a.role === "owner" },
		};
	}
	repository(grant: ConnectionGrant, repositoryId: string) {
		const c = this.controller();
		c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
		return c.state.repositories.find((r) => r.id === repositoryId)!;
	}
	saveRepository(grant: ConnectionGrant, repository: Repository) {
		const c = this.controller();
		c.repository(c.authority(grant.actor), repository);
		this.save(c);
		return repository;
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
	) {
		const compactFingerprint = await hash(fingerprint);
		const c = this.controller(),
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
		new ResourceBoundary(this.store, this.env, { namespace: c.state.namespace.id }).bind();
		this.save(c);
		return reservation;
	}
	settle(id: string, state: "complete" | "uncertain" | "released") {
		const c = this.controller();
		const r = this.store.get<ResourceReservation>(this.reservationKey(id)) ?? c.state.reservations.find((r) => r.id === id);
		if (!r) throw new DomainError(404, "Resource reservation unavailable");
		const day = Math.floor(r.at / 86400000);
		if (state === "released" && r.state !== "released") {
			if (["reserved", "uncertain"].includes(r.state)) throw new DomainError(409, "Uncertain resource reservations cannot be released");
			const used = this.store.get<number>(`budget:${day}`) ?? c.budget().used;
			r.state = state;
			this.store.batch([
				{ key: this.reservationKey(id), value: r },
				{ key: `budget:${day}`, value: Math.max(0, used - 1) },
			]);
		} else {
			r.state = state;
			this.store.put(this.reservationKey(id), r);
		}
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
