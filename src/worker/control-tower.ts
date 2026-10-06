import { DurableObject } from "cloudflare:workers";
import type { Command, Repository, RepositoryState } from "../shared/platform.ts";
import type { StorageEnv } from "./artifacts.ts";
import { continuationGrant } from "./continuation.ts";
import { SqlFs } from "./git/sql-fs.ts";
import { GitWorkspace } from "./git/workspace.ts";
import type { ConnectionGrant, NamespaceRuntime } from "./namespace-runtime.ts";
import { RepositoryRuntime } from "./repository-runtime.ts";
import { sqlStore } from "./store.ts";

interface Env extends StorageEnv {
	NAMESPACE: DurableObjectNamespace<NamespaceRuntime>;
	CRUCE_SECRET?: string;
	OAUTH_KV: KVNamespace;
}
export class ControlTower extends DurableObject<Env> {
	private store = sqlStore(this.ctx.storage.sql, (run) => this.ctx.storage.transactionSync(run));
	private runtime?: RepositoryRuntime;
	private open(repository: Repository) {
		if (!this.runtime)
			this.runtime = new RepositoryRuntime(
				this.store,
				new GitWorkspace(new SqlFs(this.ctx.storage.sql), "/repository.git"),
				this.env.NAMESPACE.getByName(repository.namespaceId),
				this.env,
				Date.now,
				{
					schedule: async (at) => {
						const current = await this.ctx.storage.getAlarm();
						if (current === null || current > at) await this.ctx.storage.setAlarm(at);
					},
					authorize: (grant) => continuationGrant(grant, this.env.OAUTH_KV),
				},
			);
		return this.runtime;
	}
	alarm() {
		const state = this.store.get<RepositoryState>("repository");
		if (state) return this.open(state.repository).recoverCleanup();
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
