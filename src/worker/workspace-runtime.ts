import { DurableObject } from "cloudflare:workers";
import { DomainError } from "../core/errors.ts";
import { initialWorkspace, WorkspaceController } from "../core/ownership.ts";
import type {
	Actor,
	Invitation,
	Repository,
	ResourceAction,
	ResourcePolicy,
	User,
	Workspace,
	WorkspaceRole,
	WorkspaceState,
} from "../shared/platform.ts";
import { ResourceBoundary } from "./deployments.ts";
import { Serial, sqlStore } from "./store.ts";
export interface ConnectionGrant {
	actor: Actor;
	scopes?: string[];
	repositories?: string[];
}
export class WorkspaceRuntime extends DurableObject<{ CRUCE_SECRET?: string }> {
	private accounts = new Serial();
	private store = sqlStore(this.ctx.storage.sql);
	private controller() {
		const state = this.store.get<WorkspaceState>("workspace");
		if (!state) throw new DomainError(404, "Workspace unavailable");
		return new WorkspaceController(state, Date.now());
	}
	initialize(workspace: Workspace) {
		const old = this.store.get<WorkspaceState>("workspace");
		if (!old) this.store.put("workspace", initialWorkspace(workspace));
		else if (old.workspace.id !== workspace.id) throw new DomainError(409, "Workspace identity mismatch");
	}
	metadata(workspace: Workspace) {
		const c = this.controller();
		if (c.state.workspace.id !== workspace.id) throw new DomainError(403, "Workspace mismatch");
		c.state.workspace = workspace;
		this.save(c);
	}
	private save(c: WorkspaceController) {
		this.store.put("workspace", c.state);
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
			workspace: c.state.workspace,
			role: a.role,
			repositories,
			members: maintain ? c.state.members : {},
			teams: maintain ? c.state.teams : [],
			policy: c.state.policy,
			account: new ResourceBoundary(this.store, this.env, { namespace: c.state.workspace.id }).account(),
			reservations: maintain ? c.state.reservations : [],
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
	member(grant: ConnectionGrant, userId: string, role?: WorkspaceRole) {
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
	async account(grant: ConnectionGrant, input: { accountId: string; token: string; label?: string } | null) {
		return this.accounts.run(async () => {
			const c = this.controller(),
				a = c.authority(grant.actor);
			if (a.actor.kind !== "human" || a.role !== "owner") throw new DomainError(403, "Workspace owner required");
			const boundary = new ResourceBoundary(this.store, this.env, { namespace: c.state.workspace.id });
			if (input) {
				const old = boundary.account();
				if (old && old.accountId !== input.accountId && c.state.reservations.some((r) => r.state !== "released"))
					throw new DomainError(409, "An account with retained resources cannot be replaced");
				return boundary.connect(input, a.actor.id);
			}
			boundary.disconnect();
			return null;
		});
	}
	reserve(grant: ConnectionGrant, repositoryId: string, id: string, fingerprint: string, action: ResourceAction, sessionId?: string) {
		const c = this.controller(),
			a = c.authority(grant.actor, repositoryId, grant.scopes, grant.repositories);
		if (!this.store.get("resource-account")) throw new DomainError(409, "Connect the workspace Cloudflare account first");
		const reservation = c.reserve(a, id, fingerprint, action, sessionId);
		this.save(c);
		return reservation;
	}
	settle(id: string, state: "complete" | "uncertain" | "released") {
		const c = this.controller();
		const r = c.state.reservations.find((r) => r.id === id);
		if (!r) throw new DomainError(404, "Resource reservation unavailable");
		r.state = state;
		this.save(c);
	}
	/** Internal DO RPC only; never returned by an HTTP route. The credential remains sealed. */
	resourceConfiguration() {
		return {
			namespace: this.controller().state.workspace.id,
			account: this.store.get("resource-account"),
			policy: this.controller().state.policy,
		};
	}
}
