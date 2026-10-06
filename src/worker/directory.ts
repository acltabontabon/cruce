import { DurableObject } from "cloudflare:workers";
import { DomainError } from "../core/errors.ts";
import { DirectoryController, type DirectoryState } from "../core/ownership.ts";
import type { User } from "../shared/platform.ts";
import { sqlStore } from "./store.ts";
export class Directory extends DurableObject {
	private store = sqlStore(this.ctx.storage.sql);
	private controller() {
		return new DirectoryController(this.store.get<DirectoryState>("directory") ?? { users: [], namespaces: [] }, Date.now(), () =>
			crypto.randomUUID(),
		);
	}
	login(identity: { tenantId: string; developerId: string; email: string }) {
		const c = this.controller();
		const user = c.login(identity.tenantId, identity.developerId, identity.email);
		this.store.put("directory", c.state);
		return user;
	}
	resolve(identity: { tenantId: string; developerId: string }) {
		return this.controller().resolve(identity.tenantId, identity.developerId);
	}
	user(id: string) {
		const user = this.controller().state.users.find((u) => u.id === id);
		if (!user) throw new DomainError(404, "User unavailable");
		return user;
	}
	users(ids: string[]) {
		return this.controller()
			.state.users.filter((u) => ids.includes(u.id))
			.map((u) => ({ id: u.id, name: u.name, email: u.email }));
	}
	namespaces() {
		return this.controller().state.namespaces;
	}
	namespace(id: string) {
		const w = this.controller().state.namespaces.find((w) => w.id === id);
		if (!w) throw new DomainError(404, "Namespace unavailable");
		return w;
	}
	create(user: User, input: { handle: string; name: string }, id: string) {
		const c = this.controller();
		const result = c.create(user, input, id);
		this.store.put("directory", c.state);
		return result;
	}
	rename(id: string, input: { handle: string; name: string }) {
		const c = this.controller();
		const result = c.rename(id, input);
		this.store.put("directory", c.state);
		return result;
	}
}
