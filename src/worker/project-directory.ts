import { DurableObject } from "cloudflare:workers";
import { CoordinationError, stable } from "../core/workstreams.ts";
import { type Principal, type ProjectConnection, projectKey } from "../shared/coordination.ts";
export interface ProjectRecord extends ProjectConnection {
	members: Record<string, "maintainer" | "contributor" | "observer">;
	createdAt: number;
}
export class ProjectDirectory extends DurableObject {
	private queue: Promise<unknown> = Promise.resolve();
	private serialize<T>(run: () => T | Promise<T>) {
		const next = this.queue.then(run);
		this.queue = next.catch(() => {});
		return next;
	}
	async projects() {
		return [...(await this.ctx.storage.list<ProjectRecord>({ prefix: "project:" })).values()];
	}
	async project(id: string) {
		const record = await this.ctx.storage.get<ProjectRecord>(`project:${id}`);
		if (!record) throw new CoordinationError(404, "Project unavailable");
		return record;
	}
	principal(identity: { developerId: string; tenantId: string }, project: ProjectRecord): Principal {
		const role = project.members[identity.developerId];
		if (!project.active || project.tenantId !== identity.tenantId || !role) throw new CoordinationError(403, "Project access denied");
		return {
			developerId: identity.developerId,
			tenantId: identity.tenantId,
			projectIds: [project.id],
			maintainer: role === "maintainer",
			canWrite: role !== "observer",
		};
	}
	/** Governance stays available to existing maintainers while source access is disabled. */
	govern(identity: { developerId: string; tenantId: string }, project: ProjectRecord) {
		if (project.tenantId !== identity.tenantId || project.members[identity.developerId] !== "maintainer")
			throw new CoordinationError(403, "Maintainer required");
	}
	create(identity: { developerId: string; tenantId: string }, name: string, idempotencyKey: string) {
		return this.serialize(async () => {
			if (!name.trim() || name.length > 200 || !idempotencyKey)
				throw new CoordinationError(400, "Project name and idempotency key required");
			const key = `create:${identity.tenantId}:${identity.developerId}:${idempotencyKey}`,
				request = stable({ name }),
				old = await this.ctx.storage.get<{ request: string; id: string }>(key);
			if (old) {
				if (old.request !== request) throw new CoordinationError(409, "Idempotency key reused");
				const project = await this.project(old.id);
				this.principal(identity, project);
				return project;
			}
			const uuid = crypto.randomUUID(),
				id = projectKey(identity.tenantId, uuid),
				r: ProjectRecord = {
					id,
					tenantId: identity.tenantId,
					name,
					artifactRepository: `project-${uuid}`,
					active: true,
					version: 1,
					capabilities: ["intent_mcp", "managed_artifacts", "native_promotion"],
					policy: { mode: "enforced", semantic: "advisory" },
					members: { [identity.developerId]: "maintainer" },
					createdAt: Date.now(),
				};
			await this.ctx.storage.put({ [`project:${id}`]: r, [key]: { request, id } });
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
			const r = await this.project(id);
			this.govern(identity, r);
			if (r.version !== expectedVersion) throw new CoordinationError(409, "Project changed");
			if (input.name !== undefined) {
				if (!input.name.trim() || input.name.length > 200) throw new CoordinationError(400, "Valid project name required");
				r.name = input.name;
			}
			if (input.member) {
				if (input.member.role === "remove") delete r.members[input.member.id];
				else r.members[input.member.id] = input.member.role;
				if (!Object.values(r.members).includes("maintainer")) throw new CoordinationError(400, "A project needs a maintainer");
			}
			if (input.active !== undefined) r.active = input.active;
			r.version++;
			await this.ctx.storage.put(`project:${id}`, r);
			return r;
		});
	}
}
