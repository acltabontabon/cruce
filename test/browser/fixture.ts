import type { IncomingMessage, ServerResponse } from "node:http";
import { stable } from "../../src/core/errors.ts";
import { DirectoryController, initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import { repositorySummary } from "../../src/shared/coordination.ts";
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
	const directory = new DirectoryController({ users: [], namespaces: [] }, FIXED_TIME, next),
		user = directory.login("fixture", "alex", "alex@example.com"),
		actor: Actor = { id: user.id, userId: user.id, name: "Alex Morgan", kind: "human" };
	user.name = "Alex Morgan";
	const personal = directory.state.namespaces[0],
		shared = directory.create(user, { handle: "fernloop", name: "Fernloop" }, "fernloop"),
		namespaces = new Map([personal, shared].map((w) => [w.id, new NamespaceController(initialNamespace(w), FIXED_TIME)]));
	personal.name = "Alex Morgan";
	const repository: Repository = {
		id: "payments",
		namespaceId: shared.id,
		name: "payment-service",
		defaultBranch: "main",
		createdAt: FIXED_TIME,
		storageName: "repo-repo",
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
	};
	const ws = namespaces.get(shared.id)!;
	ws.repository(ws.authority(actor), repository);
	const c = new RepositoryController(initialRepository(repository), FIXED_TIME, next),
		agent: Actor = { id: "codex", userId: user.id, name: "Codex", kind: "agent", connectionId: "oauth-fixture" };
	const auth = (a = actor) => ({ ...ws.authority(a), repositoryId: repository.id, repositoryRole: "maintain" as const });
	const run = (tool: string, fields: Partial<Command> = {}, a = actor) =>
		c.command({ tool, namespaceId: shared.id, repositoryId: repository.id, ...fields }, auth(a));
	for (const a of [actor, agent]) {
		const s = run(
			"start_workspace",
			{ title: a.kind === "human" ? "Inspect payment timeout" : "Implement retry policy", baseRevision: base },
			a,
		) as { id: string };
		const execution = { id: s.id, checkoutId: s.id, machineId: "fixture", kind: "worktree" as const, owned: true, branch: `cruce/${s.id}` };
		run("attach_workspace", { workspaceId: s.id, execution }, a);
		run(
			"report_change",
			{ workspaceId: s.id, execution, revision: head, changes: [{ path: "src/retry.ts", status: "modified" }], commits: [head] },
			a,
		);
	}
	c.state.sourceHead = base;
	c.state.canonical = { id: "canonical", name: repository.storageName, remote: "https://fixture.invalid/canonical.git" };
	for (const w of c.state.workspaces)
		w.fork = { id: w.id, name: `fork-${w.id}`, remote: `https://fixture.invalid/${w.id}.git`, state: "ready" };
	const workspace = c.state.workspaces[1];
	c.addArtifact({
		id: "source",
		namespaceId: shared.id,
		repositoryId: repository.id,
		workspaceId: workspace.id,
		actor: agent,
		revision: head,
		baseRevision: base,
		kind: "source",
		title: "Bounded retry policy",
		contentHash: "fixture-content-hash",
		trust: "reported",
		storage: { repository: "fixture-source", providerId: "fixture-source", revision: head },
		at: FIXED_TIME,
	});
	// The runtime records the published revision and its review base when it retains source.
	workspace.publishedRevision = head;
	workspace.integratedRevision = base;
	run("create_proposal", { artifactId: "source" }, agent);
	c.addArtifact({
		id: "test-report",
		namespaceId: shared.id,
		repositoryId: repository.id,
		workspaceId: workspace.id,
		actor: agent,
		revision: head,
		kind: "evidence",
		title: "Retry policy test report",
		contentHash: "fixture-evidence-hash",
		trust: "reported",
		storage: { repository: "fixture-evidence", providerId: "fixture-evidence", revision: head, path: "tests.txt" },
		at: FIXED_TIME,
	});
	const runtimes = new Map([[repository.id, c]]),
		calls: unknown[] = [];
	let authenticated = true,
		sessionFailure = false,
		sessionDelay = 0;
	const json = (res: ServerResponse, data: unknown, status = 200) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const handle = async (req: IncomingMessage, res: ServerResponse, nextHandler: () => void) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (
			!url.pathname.startsWith("/api/") &&
			!url.pathname.startsWith("/__fixture/") &&
			!url.pathname.startsWith("/auth/") &&
			url.pathname !== "/cdn-cgi/access/logout"
		)
			return nextHandler();
		try {
			const buffers: Buffer[] = [];
			for await (const b of req) buffers.push(Buffer.from(b));
			const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : {};
			const parts = url.pathname.split("/").filter(Boolean);
			if (url.pathname === "/cdn-cgi/access/logout") {
				// A boundary marker, not a simulation of provider session revocation.
				res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
				return res.end("<h1>Fixture Access logout boundary</h1>");
			}
			if (url.pathname === "/__fixture/session" && req.method === "POST") {
				if (typeof body.authenticated === "boolean") authenticated = body.authenticated;
				sessionFailure = body.failure ?? false;
				sessionDelay = body.delay ?? 0;
				return json(res, { configured: true });
			}
			if (url.pathname === "/auth/session") {
				const state = { authenticated },
					failure = sessionFailure;
				if (sessionDelay) await new Promise((resolve) => setTimeout(resolve, sessionDelay));
				res.setHeader("cache-control", "no-store");
				return failure ? json(res, { error: "Session verification unavailable; retry" }, 503) : json(res, state);
			}
			if (["/auth/login", "/auth/logout"].includes(url.pathname)) {
				authenticated = url.pathname === "/auth/login";
				res.writeHead(302, { location: authenticated ? "/" : "/cdn-cgi/access/logout", "cache-control": "no-store" });
				return res.end();
			}
			if (url.pathname.startsWith("/api/") && !authenticated) return json(res, { error: "Session expired" }, 401);
			if (url.pathname === "/__fixture/calls") return json(res, calls);
			if (url.pathname === "/__fixture/upstream" && req.method === "POST") {
				c.state.sourceHead = head;
				return json(res, { updated: true });
			}
			if (url.pathname === "/api/me") return json(res, { user, namespaces: directory.state.namespaces });
			if (url.pathname === "/api/namespaces" && req.method === "POST") {
				const w = directory.create(user, body, body.idempotencyKey);
				namespaces.set(w.id, new NamespaceController(initialNamespace(w), FIXED_TIME));
				return json(res, w);
			}
			const w = namespaces.get(parts[2]);
			if (!w) return json(res, { error: "Namespace access denied" }, 403);
			const a = w.authority(actor);
			if (parts.length === 3) {
				if (req.method === "PATCH") {
					Object.assign(w.state.namespace, directory.rename(w.state.namespace.id, body));
					return json(res, w.state.namespace);
				}
				const snapshots = w.state.repositories.map((r) =>
					runtimes.get(r.id)!.snapshot({ ...a, repositoryId: r.id, repositoryRole: "maintain" }),
				);
				const repositorySummaries = snapshots.map(repositorySummary);
				// Mirrors the Worker's namespace view: the newest events across its repositories.
				const activity = snapshots
					.flatMap((s) => s.activity.map((event) => ({ ...event, repositoryId: s.repository.id, repositoryName: s.repository.name })))
					.sort((x, y) => y.at - x.at)
					.slice(0, 20);
				return json(res, {
					...w.state,
					repositorySummaries,
					activity,
					role: a.role,
					people: [user],
					permissions: { maintain: true, owner: true },
					storage: { mode: "deployment", ready: true },
					budget: w.budget(),
				});
			}
			if (parts[3] === "teams") {
				w.team(a, body.id, body.name, body.members);
				return json(res, { saved: true });
			}
			if (parts[3] === "invitations") return json(res, { url: `http://localhost/invite/${w.state.namespace.id}#fixture-invitation` });
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
					namespaceId: w.state.namespace.id,
					defaultBranch: body.defaultBranch,
					storageName: `repo-${body.idempotencyKey}`,
				};
				w.repository(a, r);
				const created = new RepositoryController(initialRepository(r), FIXED_TIME, next);
				// Real creation provisions canonical storage with an initial commit; the fixture reuses the seeded base.
				created.state.canonical = { id: `canonical-${r.id}`, name: r.storageName, remote: `https://fixture.invalid/${r.id}.git` };
				created.state.sourceHead = base;
				created.event(a.actor, "repository_created", `Created ${r.name}`, [r.id, base]);
				runtimes.set(r.id, created);
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
			const cmd = CommandInput.parse({ ...body, namespaceId: w.state.namespace.id, repositoryId: runtime.state.repository.id });
			calls.push(cmd);
			if (cmd.tool === "get_activity") return json(res, { items: runtime.state.activity, cursor: undefined });
			if (cmd.tool === "inspect_retention") {
				const workspace = runtime.workspace(cmd.workspaceId);
				const reservation = w.reserve(authority, cmd.idempotencyKey!, stable(cmd), "source.read", workspace.id);
				workspace.retention = {
					checkedAt: FIXED_TIME,
					forkId: workspace.fork?.id ?? "fixture-fork",
					complete: true,
					refs: [{ ref: "refs/heads/unpublished", revision: head, retained: false }],
					blockers: ["Unretained fork refs; publish their commits before cleanup"],
				};
				reservation.state = "complete";
				return json(res, workspace.retention);
			}
			if (cmd.tool === "inspect_source" || cmd.tool === "recover_source") {
				if (!cmd.idempotencyKey) return json(res, { error: "Mutation requires an idempotency key" }, 400);
				const reservation = w.reserve(authority, cmd.idempotencyKey, stable(cmd), "source.read");
				const revision = cmd.revision ?? runtime.state.sourceHead ?? head;
				let result: unknown;
				if (cmd.tool === "recover_source") result = { revision, recovered: true };
				else if (cmd.sourceView === "diff") result = await git.reviewChanges(cmd.baseRevision ?? base, revision, cmd.path);
				else if (cmd.sourceView === "artifact")
					result = {
						artifact: runtime.artifact(cmd.artifactId),
						content: "Reported tests: 12 passed for the bounded retry revision. Fixture evidence only.",
					};
				else if (cmd.sourceView === "history") {
					const commits: Awaited<ReturnType<GitWorkspace["log"]>> = [];
					let oid: string | undefined = revision;
					while (oid && commits.length < 31) {
						const c: Awaited<ReturnType<GitWorkspace["log"]>>[number] | undefined = (await git.log(oid, 1))[0];
						if (!c) break;
						commits.push(c);
						oid = c.parents[0];
					}
					result = { revision, traversal: "first-parent", truncated: commits.length > 30, commits: commits.slice(0, 30) };
				} else {
					const files = await git.readFiles(revision);
					result = cmd.path
						? { revision, file: { path: cmd.path, content: files[cmd.path] } }
						: { revision, paths: Object.keys(files).sort() };
				}
				reservation.state = "complete";
				return json(res, result);
			}
			if (cmd.tool === "get_workspace_updates") {
				const workspace = runtime.workspace(cmd.workspaceId),
					updates = runtime.workspaceUpdates(workspace);
				const changes = updates.revision ? (await git.reviewChanges(updates.baselineRevision, updates.revision)).files : [];
				const touched = new Set(workspace.changes.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]));
				return json(res, {
					...updates,
					available: !!updates.revision,
					comparison: updates.revision === workspace.headRevision ? "current" : "unavailable",
					changes,
					overlappingPaths: changes.map((f) => f.path).filter((p) => touched.has(p)),
					overlapTrust: "reported",
				});
			}
			if (cmd.tool === "get_source") return json(res, { revision: cmd.revision, files: await git.readFiles(cmd.revision ?? head) });
			if (cmd.tool === "get_history") return json(res, await git.log(cmd.revision ?? head));
			if (cmd.tool === "get_diff") return json(res, await git.reviewChanges(cmd.baseRevision ?? base, cmd.revision ?? head, cmd.path));
			if (cmd.tool === "read_artifact")
				return json(res, {
					artifact: runtime.artifact(cmd.artifactId),
					content:
						cmd.artifactId === "test-report"
							? "Reported tests: 12 passed for the bounded retry revision. Fixture evidence only."
							: undefined,
				});
			if (cmd.tool === "promote_proposal") {
				// Simulated canonical update: the real Worker pushes with a non-forced Git update. Readiness still gates it.
				const proposal = runtime.proposal(cmd.proposalId);
				const readiness = runtime.readiness(proposal);
				if (!readiness.ready) return json(res, { error: readiness.reasons.join("; ") }, 409);
				const promotion = {
					id: `promotion-${proposal.id}`,
					proposalId: proposal.id,
					from: proposal.base,
					to: proposal.revision,
					actor: authority.actor,
					at: FIXED_TIME,
					state: "complete" as const,
				};
				runtime.state.promotions.push(promotion);
				proposal.state = "promoted";
				runtime.state.sourceHead = proposal.revision;
				runtime.event(authority.actor, "source_promoted", proposal.title, [proposal.id, proposal.revision, promotion.id]);
				return json(res, promotion);
			}
			return json(res, runtime.command(cmd, authority));
		} catch (e) {
			return json(res, { error: (e as Error).message }, 400);
		}
	};
	return { handle, base, head };
}
