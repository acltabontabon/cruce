import { DurableObject } from "cloudflare:workers";
import { CoordinationError, stable } from "../core/workstreams.ts";
import { type Principal, type SystemConnection, systemKey } from "../shared/coordination.ts";
export interface SystemRecord extends SystemConnection {
	members: Record<string, "maintainer" | "contributor" | "observer">;
	createdAt: number;
}
export class SystemDirectory extends DurableObject {
	private queue: Promise<unknown> = Promise.resolve();
	private serialize<T>(run: () => T | Promise<T>) {
		const next = this.queue.then(run);
		this.queue = next.catch(() => {});
		return next;
	}
	async systems() {
		return [...(await this.ctx.storage.list<SystemRecord>({ prefix: "system:" })).values()];
	}
	async system(id: string) {
		const record = await this.ctx.storage.get<SystemRecord>(`system:${id}`);
		if (!record) throw new CoordinationError(404, "System unavailable");
		return record;
	}
	principal(identity: { developerId: string; tenantId: string }, system: SystemRecord): Principal {
		const role = system.members[identity.developerId];
		if (!system.active || system.tenantId !== identity.tenantId || !role) throw new CoordinationError(403, "System access denied");
		return {
			developerId: identity.developerId,
			tenantId: identity.tenantId,
			systemIds: [system.id],
			maintainer: role === "maintainer",
			canWrite: role !== "observer",
		};
	}
	/** Governance stays available to existing maintainers while source access is disabled. */
	govern(identity: { developerId: string; tenantId: string }, system: SystemRecord) {
		if (system.tenantId !== identity.tenantId || system.members[identity.developerId] !== "maintainer")
			throw new CoordinationError(403, "Maintainer required");
	}
	create(identity: { developerId: string; tenantId: string }, name: string, idempotencyKey: string) {
		return this.serialize(async () => {
			if (!name.trim() || name.length > 200 || !idempotencyKey)
				throw new CoordinationError(400, "System name and idempotency key required");
			const key = `create:${identity.tenantId}:${identity.developerId}:${idempotencyKey}`,
				request = stable({ name }),
				old = await this.ctx.storage.get<{ request: string; id: string }>(key);
			if (old) {
				if (old.request !== request) throw new CoordinationError(409, "Idempotency key reused");
				const system = await this.system(old.id);
				this.principal(identity, system);
				return system;
			}
			const uuid = crypto.randomUUID(),
				id = systemKey(identity.tenantId, uuid),
				r: SystemRecord = {
					id,
					tenantId: identity.tenantId,
					name,
					artifactRepository: `system-${uuid}`,
					active: true,
					version: 1,
					capabilities: ["intent_mcp", "managed_artifacts", "native_promotion"],
					policy: { mode: "enforced", semantic: "advisory" },
					members: { [identity.developerId]: "maintainer" },
					createdAt: Date.now(),
				};
			await this.ctx.storage.put({ [`system:${id}`]: r, [key]: { request, id } });
			return r;
		});
	}
	update(
		identity: { developerId: string; tenantId: string },
		id: string,
		expectedVersion: number,
		input: { name?: string; active?: boolean; member?: { id: string; role: "maintainer" | "contributor" | "observer" | "remove" } },
	) {
		return this.serialize(async () => {
			const r = await this.system(id);
			this.govern(identity, r);
			if (r.version !== expectedVersion) throw new CoordinationError(409, "System changed");
			if (input.name !== undefined) {
				if (!input.name.trim() || input.name.length > 200) throw new CoordinationError(400, "Valid system name required");
				r.name = input.name;
			}
			if (input.member) {
				if (input.member.role === "remove") delete r.members[input.member.id];
				else r.members[input.member.id] = input.member.role;
				if (!Object.values(r.members).includes("maintainer")) throw new CoordinationError(400, "A system needs a maintainer");
			}
			if (input.active !== undefined) r.active = input.active;
			r.version++;
			await this.ctx.storage.put(`system:${id}`, r);
			return r;
		});
	}
}
