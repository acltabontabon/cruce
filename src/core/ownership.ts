import type {
	Actor,
	Authority,
	Invitation,
	Repository,
	RepositoryRole,
	ResourceAction,
	ResourcePolicy,
	User,
	Workspace,
	WorkspaceRole,
	WorkspaceState,
} from "../shared/platform.ts";
import { DEFAULT_RESOURCE_POLICY, workspaceMaintain } from "./capabilities.ts";
import { DomainError, stable } from "./errors.ts";

export interface DirectoryState {
	users: User[];
	workspaces: Workspace[];
}
export class DirectoryController {
	constructor(
		readonly state: DirectoryState,
		readonly now: number,
		readonly nextId: () => string,
	) {}
	login(issuer: string, subject: string, email: string) {
		let user = this.state.users.find((u) => u.issuer === issuer && u.subject === subject);
		if (user) {
			user.email = email.toLowerCase();
			return user;
		}
		const userId = this.nextId(),
			workspaceId = this.nextId();
		const base =
			email
				.split("@")[0]
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 45) || "personal";
		let handle = base,
			n = 1;
		while (this.state.workspaces.some((w) => w.handle === handle)) handle = `${base}-${n++}`;
		user = { id: userId, issuer, subject, email: email.toLowerCase(), name: email.split("@")[0], personalWorkspaceId: workspaceId };
		this.state.users.push(user);
		this.state.workspaces.push({ id: workspaceId, handle, name: user.name, kind: "personal", ownerId: userId, createdAt: this.now });
		return user;
	}
	create(user: User, input: { handle: string; name: string }, id: string) {
		const old = this.state.workspaces.find((w) => w.id === id);
		if (old) {
			if (old.ownerId !== user.id || old.handle !== input.handle || old.name !== input.name)
				throw new DomainError(409, "Creation key reused");
			return old;
		}
		if (this.state.workspaces.some((w) => w.handle === input.handle)) throw new DomainError(409, "Workspace handle already used");
		const workspace: Workspace = { id, ...input, ownerId: user.id, kind: "shared", createdAt: this.now };
		this.state.workspaces.push(workspace);
		return workspace;
	}
	rename(id: string, input: { handle: string; name: string }) {
		if (this.state.workspaces.some((w) => w.id !== id && w.handle === input.handle))
			throw new DomainError(409, "Workspace handle already used");
		const w = this.state.workspaces.find((w) => w.id === id);
		if (!w) throw new DomainError(404, "Workspace unavailable");
		Object.assign(w, input);
		return w;
	}
}
export const initialWorkspace = (workspace: Workspace): WorkspaceState => ({
	workspace,
	members: { [workspace.ownerId]: "owner" },
	teams: [],
	invitations: [],
	repositories: [],
	policy: structuredClone(DEFAULT_RESOURCE_POLICY),
	reservations: [],
	version: 1,
});
const rank: Record<RepositoryRole, number> = { read: 1, write: 2, maintain: 3 };
export function repositoryRole(state: WorkspaceState, repository: Repository, userId: string): RepositoryRole | undefined {
	const role = state.members[userId];
	if (!role || repository.workspaceId !== state.workspace.id) return;
	if (role === "owner" || role === "maintainer") return "maintain";
	const teams = state.teams.filter((t) => t.members.includes(userId)).map((t) => t.id);
	const granted = repository.grants
		.filter((g) => (g.subject === "user" ? g.id === userId : teams.includes(g.id)))
		.reduce((max, g) => Math.max(max, rank[g.role]), 0);
	const effective = Math.min(granted, role === "viewer" ? 1 : 2);
	return effective === 2 ? "write" : effective === 1 ? "read" : undefined;
}
export class WorkspaceController {
	constructor(
		readonly state: WorkspaceState,
		readonly now: number,
	) {}
	authority(actor: Actor, repositoryId?: string, scopes?: string[], approvedRepositories?: string[]): Authority {
		const role = this.state.members[actor.userId];
		if (!role || actor.kind === "system") throw new DomainError(403, "Workspace access denied");
		let access: RepositoryRole | undefined;
		if (repositoryId) {
			const repository = this.state.repositories.find((r) => r.id === repositoryId);
			access = repository ? repositoryRole(this.state, repository, actor.userId) : undefined;
			if (!access) throw new DomainError(403, "Repository access denied");
			if (actor.kind === "agent" && (!approvedRepositories?.includes(repositoryId) || !scopes?.includes("cruce:read")))
				throw new DomainError(403, "Repository not authorized for this agent connection");
		}
		return { actor, workspaceId: this.state.workspace.id, repositoryId, role, repositoryRole: access, scopes };
	}
	member(a: Authority, userId: string, role?: WorkspaceRole) {
		workspaceMaintain(a);
		if (this.state.workspace.kind === "personal")
			throw new DomainError(409, "Personal workspaces have one owner; create a shared workspace to collaborate");
		if (this.state.members[userId] === "owner" || role === "owner")
			throw new DomainError(403, "Workspace ownership cannot be changed through membership");
		if (role === "maintainer" && a.role !== "owner") throw new DomainError(403, "Only owners appoint maintainers");
		if (this.state.members[userId] === "maintainer" && a.role !== "owner") throw new DomainError(403, "Only owners change maintainers");
		if (role) this.state.members[userId] = role;
		else {
			delete this.state.members[userId];
			for (const t of this.state.teams) t.members = t.members.filter((id) => id !== userId);
			for (const r of this.state.repositories) r.grants = r.grants.filter((g) => g.subject !== "user" || g.id !== userId);
		}
		this.state.version++;
	}
	team(a: Authority, id: string, name: string, members: string[]) {
		workspaceMaintain(a);
		if (this.state.workspace.kind !== "shared") throw new DomainError(409, "Teams belong to shared workspaces");
		if (members.some((u) => !this.state.members[u])) throw new DomainError(400, "Team members must belong to the workspace");
		const t = this.state.teams.find((t) => t.id === id);
		if (t) Object.assign(t, { name, members: [...new Set(members)] });
		else this.state.teams.push({ id, name, members: [...new Set(members)] });
		this.state.version++;
	}
	invite(a: Authority, invitation: Invitation) {
		workspaceMaintain(a);
		if (this.state.workspace.kind !== "shared" || (invitation.role === "maintainer" && a.role !== "owner"))
			throw new DomainError(403, "Invitation not permitted");
		this.state.invitations.push(invitation);
		this.state.version++;
	}
	accept(user: User, tokenHash: string) {
		const i = this.state.invitations.find((i) => i.tokenHash === tokenHash);
		if (!i || i.expiresAt <= this.now || i.email.toLowerCase() !== user.email.toLowerCase() || (i.acceptedBy && i.acceptedBy !== user.id))
			throw new DomainError(403, "Invitation invalid or expired");
		if (i.acceptedBy) return;
		if (!this.state.members[user.id]) this.state.members[user.id] = i.role;
		i.acceptedBy = user.id;
		this.state.version++;
	}
	repository(a: Authority, repository: Repository) {
		workspaceMaintain(a);
		if (repository.workspaceId !== this.state.workspace.id) throw new DomainError(403, "Workspace mismatch");
		if (this.state.repositories.some((r) => r.id !== repository.id && r.name === repository.name))
			throw new DomainError(409, "Repository name already used");
		for (const g of repository.grants)
			if (g.subject === "user" ? !this.state.members[g.id] : !this.state.teams.some((t) => t.id === g.id))
				throw new DomainError(400, "Grant requires a workspace member or team");
		const i = this.state.repositories.findIndex((r) => r.id === repository.id);
		if (i < 0) this.state.repositories.push(repository);
		else this.state.repositories[i] = repository;
		this.state.version++;
	}
	setPolicy(a: Authority, policy: ResourcePolicy) {
		workspaceMaintain(a);
		if (policy.rules["production.deploy"] === "allow") throw new DomainError(400, "Production always needs human approval");
		this.state.policy = policy;
		this.state.version++;
	}
	reserve(a: Authority, id: string, fingerprint: string, action: ResourceAction, sessionId?: string) {
		const repo = this.state.repositories.find((r) => r.id === a.repositoryId);
		if (!repo || !a.repositoryRole || a.repositoryRole === "read") throw new DomainError(403, "Repository write permission required");
		const key = `${a.actor.id}:${id}`,
			full = stable({ fingerprint, action, repositoryId: repo.id, sessionId });
		const rules = [this.state.policy.rules[action], repo.policy.resourceRules[action]];
		if (rules.includes("deny")) throw new DomainError(403, "Resource policy denies this operation");
		const human = a.actor.kind === "human" && a.repositoryRole === "maintain";
		if ((action === "production.deploy" || rules.includes("approval")) && !human)
			throw new DomainError(403, "Human maintainer approval required");
		const previous = this.state.reservations.find((r) => r.id === key);
		if (previous) {
			if (previous.fingerprint !== full) throw new DomainError(409, "Resource operation identity reused");
			return previous;
		}
		const day = Math.floor(this.now / 86400000);
		const used = this.state.reservations.filter((r) => r.state !== "released" && Math.floor(r.at / 86400000) === day);
		if (used.length >= this.state.policy.dailyLimit)
			throw new DomainError(403, "Workspace daily resource budget reached; update the workspace limit explicitly");
		if (
			action === "preview.deploy" &&
			this.state.reservations.filter((r) => r.action === action && r.sessionId === sessionId && r.state !== "released").length >=
				this.state.policy.previewsPerSession
		)
			throw new DomainError(403, "Session preview budget reached; update the workspace limit explicitly");
		const reservation = {
			id: key,
			fingerprint: full,
			repositoryId: repo.id,
			sessionId,
			action,
			actorId: a.actor.id,
			at: this.now,
			state: "reserved" as const,
		};
		this.state.reservations.push(reservation);
		return reservation;
	}
}
