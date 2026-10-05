import type { IncomingMessage, ServerResponse } from "node:http";
import { DirectoryController, initialWorkspace, WorkspaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import { type Actor, type Command, CommandInput, type Repository } from "../../src/shared/platform.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
export const FIXED_TIME = 1791158400000;
export async function fixture() {
	const git = new GitWorkspace(new MemoryFs() as never);
	await git.ensureInit();
	const author = { name: "Fixture", email: "fixture@cruce.invalid", timestamp: Math.floor(FIXED_TIME / 1000) };
	const base = await git.commit({
		ref: "refs/heads/main",
		parent: null,
		files: { "src/retry.ts": "export const retries = 1;\n", "AGENTS.md": "Preserve bounded retries.\n" },
		message: "Baseline",
		author,
	});
	const head = await git.commit({
		ref: "refs/heads/retry",
		parent: base,
		files: { "src/retry.ts": "export const retries = 3;\n" },
		message: "Bound retries",
		author,
	});
	let counter = 0;
	const next = () => `fixture-${++counter}`;
	const directory = new DirectoryController({ users: [], workspaces: [] }, FIXED_TIME, next),
		user = directory.login("fixture", "alex", "alex@example.com"),
		actor: Actor = { id: user.id, userId: user.id, name: "Alex Morgan", kind: "human" };
	user.name = "Alex Morgan";
	const personal = directory.state.workspaces[0],
		shared = directory.create(user, { handle: "fernloop", name: "Fernloop" }, "fernloop"),
		workspaces = new Map([personal, shared].map((w) => [w.id, new WorkspaceController(initialWorkspace(w), FIXED_TIME)]));
	personal.name = "Alex Morgan";
	const repository: Repository = {
		id: "payments",
		workspaceId: shared.id,
		name: "payment-service",
		defaultBranch: "main",
		createdAt: FIXED_TIME,
		source: { kind: "local" },
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
	};
	const ws = workspaces.get(shared.id)!;
	ws.repository(ws.authority(actor), repository);
	const c = new RepositoryController(initialRepository(repository), FIXED_TIME, next),
		agent: Actor = { id: "codex", userId: user.id, name: "Codex", kind: "agent", connectionId: "oauth-fixture" };
	const auth = (a = actor) => ({ ...ws.authority(a), repositoryId: repository.id, repositoryRole: "maintain" as const });
	const run = (tool: string, fields: Partial<Command> = {}, a = actor) =>
		c.command({ tool, workspaceId: shared.id, repositoryId: repository.id, ...fields }, auth(a));
	for (const a of [actor, agent]) {
		const s = run(
			"start_session",
			{ title: a.kind === "human" ? "Inspect payment timeout" : "Implement retry policy", baseRevision: base },
			a,
		) as { id: string };
		run(
			"attach_session",
			{
				sessionId: s.id,
				execution: { id: s.id, checkoutId: s.id, machineId: "fixture", kind: "worktree", owned: true, branch: `cruce/${s.id}` },
			},
			a,
		);
		run("report_change", { sessionId: s.id, revision: head, changes: [{ path: "src/retry.ts", status: "modified" }], commits: [head] }, a);
	}
	const session = c.state.sessions[1];
	c.addArtifact({
		id: "source",
		workspaceId: shared.id,
		repositoryId: repository.id,
		sessionId: session.id,
		actor: agent,
		revision: head,
		kind: "source",
		title: "Bounded retry policy",
		contentHash: "fixture-content-hash",
		trust: "reported",
		storage: { repository: "fixture-source", revision: head },
		at: FIXED_TIME,
	});
	run("create_proposal", { artifactId: "source" }, agent);
	const runtimes = new Map([[repository.id, c]]),
		calls: unknown[] = [];
	const json = (res: ServerResponse, data: unknown, status = 200) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const handle = async (req: IncomingMessage, res: ServerResponse, nextHandler: () => void) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__fixture/")) return nextHandler();
		try {
			const buffers: Buffer[] = [];
			for await (const b of req) buffers.push(Buffer.from(b));
			const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : {};
			const parts = url.pathname.split("/").filter(Boolean);
			if (url.pathname === "/__fixture/calls") return json(res, calls);
			if (url.pathname === "/api/me") return json(res, { user, workspaces: directory.state.workspaces });
			if (url.pathname === "/api/workspaces" && req.method === "POST") {
				const w = directory.create(user, body, body.idempotencyKey);
				workspaces.set(w.id, new WorkspaceController(initialWorkspace(w), FIXED_TIME));
				return json(res, w);
			}
			const w = workspaces.get(parts[2]);
			if (!w) return json(res, { error: "Workspace access denied" }, 403);
			const a = w.authority(actor);
			if (parts.length === 3) {
				if (req.method === "PATCH") {
					Object.assign(w.state.workspace, directory.rename(w.state.workspace.id, body));
					return json(res, w.state.workspace);
				}
				const repositorySummaries = w.state.repositories.map((r) => {
					const snapshot = runtimes.get(r.id)!.snapshot({ ...a, repositoryId: r.id, repositoryRole: "maintain" });
					return {
						id: r.id,
						active: snapshot.sessions.filter((session) => session.state === "active").length,
						overlaps: snapshot.overlaps.length,
						latestArtifact: snapshot.artifacts.at(-1),
					};
				});
				return json(res, { ...w.state, repositorySummaries, role: a.role, people: [user], permissions: { maintain: true, owner: true } });
			}
			if (parts[3] === "teams") {
				w.team(a, body.id, body.name, body.members);
				return json(res, { saved: true });
			}
			if (parts[3] === "invitations") return json(res, { url: `http://localhost/invite/${w.state.workspace.id}#fixture-invitation` });
			if (parts[3] === "policy") {
				w.setPolicy(a, body);
				return json(res, { saved: true });
			}
			if (parts[3] !== "repositories") return json(res, { error: "Not found" }, 404);
			if (parts.length === 4) {
				if (req.method === "GET") return json(res, w.state.repositories);
				const r: Repository = {
					...repository,
					id: body.idempotencyKey,
					name: body.name,
					workspaceId: w.state.workspace.id,
					defaultBranch: body.defaultBranch,
					source: { kind: body.source },
				};
				w.repository(a, r);
				runtimes.set(r.id, new RepositoryController(initialRepository(r), FIXED_TIME, next));
				return json(res, r);
			}
			const runtime = runtimes.get(parts[4]);
			if (!runtime) return json(res, { error: "Repository access denied" }, 403);
			const authority = { ...a, repositoryId: runtime.state.repository.id, repositoryRole: "maintain" as const };
			if (req.method === "PATCH") {
				Object.assign(runtime.state.repository, body);
				w.repository(a, runtime.state.repository);
				return json(res, runtime.state.repository);
			}
			if (req.method === "GET") return json(res, runtime.snapshot(authority));
			const cmd = CommandInput.parse({ ...body, workspaceId: w.state.workspace.id, repositoryId: runtime.state.repository.id });
			calls.push(cmd);
			if (cmd.tool === "get_source") return json(res, { revision: cmd.revision, files: await git.readFiles(cmd.revision ?? head) });
			if (cmd.tool === "get_history") return json(res, await git.log(cmd.revision ?? head));
			if (cmd.tool === "get_diff") return json(res, await git.reviewChanges(cmd.baseRevision ?? base, cmd.revision ?? head, cmd.path));
			if (cmd.tool === "read_artifact") return json(res, { artifact: runtime.artifact(cmd.artifactId) });
			return json(res, runtime.command(cmd, authority));
		} catch (e) {
			return json(res, { error: (e as Error).message }, 400);
		}
	};
	return { handle, base, head };
}
