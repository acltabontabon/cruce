import { DurableObject } from "cloudflare:workers";
import { DomainError } from "../core/errors.ts";
import { DirectoryController, type DirectoryState } from "../core/ownership.ts";
import { STATE_LIMITS } from "../shared/limits.ts";
import type { Namespace, User } from "../shared/platform.ts";
import { sqlStore } from "./store.ts";

const identityKey = (issuer: string, subject: string) => `identity:${JSON.stringify([issuer, subject])}`;
export class Directory extends DurableObject {
	private store = sqlStore(this.ctx.storage.sql, (run) => this.ctx.storage.transactionSync(run));
	private legacy() {
		const state = this.store.get<DirectoryState>("directory");
		if (state && (state.namespaces.length > STATE_LIMITS.namespaceCandidates || state.users.length > 10_000))
			throw new DomainError(409, "Directory layout exceeds the supported conversion limit");
		return state;
	}
	/** Explicit sign-in converts the same domain records, preserving every stable ID.
	 * Reads of an existing layout remain pure until that sign-in succeeds. */
	private indexExisting() {
		const state = this.legacy();
		if (!state) return;
		const rows = state.users.length * (2 + state.namespaces.length) + state.namespaces.length * 2;
		if (rows > STATE_LIMITS.directoryConversionRecords)
			throw new DomainError(409, "Directory layout exceeds the supported conversion limit");
		this.store.admit(rows * 1024, rows);
		const entries: { key: string; value: unknown }[] = [];
		for (const namespace of state.namespaces)
			entries.push({ key: `namespace:${namespace.id}`, value: namespace }, { key: `handle:${namespace.handle}`, value: namespace.id });
		for (const user of state.users) {
			entries.push({ key: `user:${user.id}`, value: user }, { key: identityKey(user.issuer, user.subject), value: user.id });
			// The old global discovery scan is retained as conservative candidates.
			// Membership still comes exclusively from each Namespace DO.
			for (const namespace of state.namespaces) entries.push({ key: `access:${user.id}:${namespace.id}`, value: namespace.id });
		}
		this.ctx.storage.transactionSync(() => {
			this.store.batch(entries);
			this.store.delete("directory");
		});
	}
	login(identity: { tenantId: string; developerId: string; email: string }) {
		this.indexExisting();
		const previous = this.store.get<string>(identityKey(identity.tenantId, identity.developerId));
		if (previous) {
			const user = { ...this.user(previous), email: identity.email.toLowerCase() };
			this.store.put(`user:${user.id}`, user);
			return user;
		}
		this.store.admit(8192, 6);
		const c = new DirectoryController({ users: [], namespaces: [] }, Date.now(), () => crypto.randomUUID());
		const user = c.login(identity.tenantId, identity.developerId, identity.email);
		const namespace = c.state.namespaces[0];
		const base = namespace.handle;
		let suffix = 0;
		while (this.store.get(`handle:${namespace.handle}`)) {
			if (++suffix > STATE_LIMITS.namespaceCandidates) throw new DomainError(409, "Namespace handle allocation limit reached");
			namespace.handle = `${base}-${suffix}`;
		}
		this.store.batch([
			{ key: `user:${user.id}`, value: user },
			{ key: identityKey(user.issuer, user.subject), value: user.id },
			{ key: `namespace:${namespace.id}`, value: namespace },
			{ key: `handle:${namespace.handle}`, value: namespace.id },
			{ key: `access:${user.id}:${namespace.id}`, value: namespace.id },
		]);
		return user;
	}
	resolve(identity: { tenantId: string; developerId: string }) {
		const id = this.store.get<string>(identityKey(identity.tenantId, identity.developerId));
		if (!id) {
			const previous = this.legacy()?.users.find((u) => u.issuer === identity.tenantId && u.subject === identity.developerId);
			if (previous) return previous;
			throw new DomainError(401, "Sign in to initialize your Cruce identity");
		}
		return this.user(id);
	}
	user(id: string) {
		const user = this.store.get<User>(`user:${id}`) ?? this.legacy()?.users.find((u) => u.id === id);
		if (!user) throw new DomainError(404, "User unavailable");
		return user;
	}
	users(ids: string[]) {
		if (ids.length > 1000) throw new DomainError(413, "Directory lookup exceeds its entry limit");
		return ids.flatMap((id) => {
			const user = this.store.get<User>(`user:${id}`) ?? this.legacy()?.users.find((u) => u.id === id);
			return user ? [{ id: user.id, name: user.name, email: user.email }] : [];
		});
	}
	/** Discovery candidates only. Namespace membership/grants are rechecked by callers. */
	namespaces(userId: string) {
		const legacy = this.legacy();
		if (legacy) return legacy.namespaces;
		return this.store
			.scan<string>(`access:${userId}:`, undefined, STATE_LIMITS.namespaceCandidates)
			.map(({ value }) => this.namespace(value));
	}
	namespace(id: string) {
		const namespace = this.store.get<Namespace>(`namespace:${id}`) ?? this.legacy()?.namespaces.find((n) => n.id === id);
		if (!namespace) throw new DomainError(404, "Namespace unavailable");
		return namespace;
	}
	/** Register before a membership operation so lost responses cannot hide a successful grant. */
	candidate(userId: string, namespaceId: string) {
		this.indexExisting();
		this.user(userId);
		this.namespace(namespaceId);
		const key = `access:${userId}:${namespaceId}`;
		if (this.store.get(key)) return;
		if (this.namespaces(userId).length >= STATE_LIMITS.namespaceCandidates)
			throw new DomainError(409, "Namespace discovery capacity reached");
		this.store.admit(1024, 1);
		this.store.put(key, namespaceId);
	}
	create(user: User, input: { handle: string; name: string }, id: string) {
		this.indexExisting();
		const old = this.store.get<Namespace>(`namespace:${id}`);
		const handle = this.store.get<string>(`handle:${input.handle}`);
		if (handle && handle !== id) throw new DomainError(409, "Namespace handle already used");
		if (!handle) this.store.admit(4096, 1);
		const c = new DirectoryController(
			{ users: [], namespaces: [old, handle && handle !== id ? this.namespace(handle) : undefined].filter((n): n is Namespace => !!n) },
			Date.now(),
			() => id,
		);
		const result = c.create(user, input, id);
		if (old) return result;
		if (this.namespaces(user.id).length >= STATE_LIMITS.namespaceCandidates)
			throw new DomainError(409, "Namespace discovery capacity reached");
		this.store.admit(4096, 3);
		this.store.batch([
			{ key: `namespace:${id}`, value: result },
			{ key: `handle:${result.handle}`, value: id },
			{ key: `access:${user.id}:${id}`, value: id },
		]);
		return result;
	}
	rename(id: string, input: { handle: string; name: string }) {
		this.indexExisting();
		const old = this.namespace(id),
			handle = this.store.get<string>(`handle:${input.handle}`);
		if (handle && handle !== id) throw new DomainError(409, "Namespace handle already used");
		if (!handle) this.store.admit(4096, 1);
		const c = new DirectoryController(
			{ users: [], namespaces: [old, handle && handle !== id ? this.namespace(handle) : undefined].filter((n): n is Namespace => !!n) },
			Date.now(),
			() => id,
		);
		const previousHandle = old.handle;
		const result = c.rename(id, input);
		this.ctx.storage.transactionSync(() => {
			this.store.batch([
				{ key: `namespace:${id}`, value: result },
				{ key: `handle:${input.handle}`, value: id },
			]);
			if (previousHandle !== input.handle) this.store.delete(`handle:${previousHandle}`);
		});
		return result;
	}
}
