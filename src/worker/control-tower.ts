import { DurableObject } from "cloudflare:workers";
import type { Command, Repository } from "../shared/platform.ts";
import { SqlFs } from "./git/sql-fs.ts";
import { GitWorkspace } from "./git/workspace.ts";
import type { ConnectionGrant, NamespaceRuntime } from "./namespace-runtime.ts";
import { RepositoryRuntime } from "./repository-runtime.ts";
import { sqlStore } from "./store.ts";

interface Env {
	NAMESPACE: DurableObjectNamespace<NamespaceRuntime>;
	CRUCE_SECRET?: string;
}
export class ControlTower extends DurableObject<Env> {
	private store = sqlStore(this.ctx.storage.sql);
	private runtime?: RepositoryRuntime;
	private open(repository: Repository) {
		if (!this.runtime)
			this.runtime = new RepositoryRuntime(
				this.store,
				new GitWorkspace(new SqlFs(this.ctx.storage.sql), "/repository.git"),
				this.env.NAMESPACE.getByName(repository.namespaceId),
				this.env,
			);
		this.runtime.initialize(repository);
		return this.runtime;
	}
	command(repository: Repository, cmd: Command, grant: ConnectionGrant) {
		return this.open(repository).command(cmd, grant);
	}
	gitRequest(repository: Repository, request: Request, grant: ConnectionGrant) {
		return this.open(repository).gitRequest(request, grant);
	}
	exportSource(repository: Repository, revision: string, grant: ConnectionGrant) {
		return this.open(repository).exportSource(revision, grant);
	}
}
