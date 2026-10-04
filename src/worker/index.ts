import { ControllerError } from "../core/controller.ts";
import { CoordinationError } from "../core/workstreams.ts";
import { DemoCommand, HumanCommand, PROJECTS } from "../shared/api.ts";
import { type AuthProps, authRoute, oauthProvider } from "./auth.ts";
import type { ControlTower } from "./control-tower.ts";
import { isArtifactsEvent } from "./event-subscriptions.ts";
import { type PlatformEnv, platformRoute } from "./platform-router.ts";

export { ControlTower } from "./control-tower.ts";
export { ProjectDirectory } from "./project-directory.ts";

interface Env extends PlatformEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	ARTIFACTS_NAMESPACE: string;
	CRUCE_SECRET?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const tower = (env: Env, projectId: string) => env.CONTROL_TOWER.getByName(projectId);

async function body<T>(
	request: Request,
	schema: {
		safeParse(
			v: unknown,
		): { success: true; data: T } | { success: false; error: { message: string; issues?: { path: PropertyKey[]; message: string }[] } };
	},
): Promise<T> {
	const raw = await request.json().catch(() => {
		throw new HttpError(400, "invalid JSON");
	});
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const explanation = parsed.error.issues
			?.slice(0, 3)
			.map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
			.join("; ");
		throw new HttpError(400, explanation ?? "Invalid request");
	}
	return parsed.data;
}

/** The deterministic coordination demo (`/demo`). Native projects live under /api/projects and /mcp. */
async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== "api") return new Response("Not found", { status: 404 });

	if (parts[1] === "health") return json({ ok: true, service: "cruce" });
	if (parts[1] !== "demo") throw new HttpError(404, "not found");
	if (parts.length === 2) return json(PROJECTS);

	const project = PROJECTS.find((p) => p.id === parts[2]);
	if (!project) throw new HttpError(404, "unknown demo");
	const stub = tower(env, project.id);
	const action = parts[3];

	if (!action && request.method === "GET") return json(await stub.snapshot(project.id));

	if (action === "ws") {
		const headers = new Headers(request.headers);
		headers.set("x-cruce-project", project.id);
		return stub.fetch(new Request(request, { headers }));
	}

	if (action === "demo" && request.method === "POST") return json(await stub.demo(project.id, await body(request, DemoCommand)));

	if (action === "commands" && request.method === "POST")
		return json(await stub.command(project.id, await body(request, HumanCommand), "you"));

	if (action === "history" && request.method === "GET") {
		const target = url.searchParams.get("target") ?? "canonical";
		if (!/^(canonical|F-\d{3})$/.test(target)) throw new HttpError(400, "bad target");
		return json(await stub.history(project.id, target));
	}

	if (action === "audit" && request.method === "GET") return json(await stub.auditLog(project.id));

	if (action === "flights" && parts.length === 6 && parts[5] === "changes" && request.method === "GET") {
		const flightId = parts[4];
		if (!/^F-\d{3}$/.test(flightId)) throw new HttpError(400, "bad flight id");
		const path = url.searchParams.get("path") ?? undefined;
		if (
			path !== undefined &&
			(!path ||
				path.length > 400 ||
				path.includes("\\") ||
				path.includes("\0") ||
				path.split("/").some((part) => !part || part === "." || part === ".."))
		) {
			throw new HttpError(400, "invalid file path");
		}
		return json(await stub.changes(project.id, flightId, path));
	}

	throw new HttpError(404, "not found");
}

const legacy = {
	async fetch(request, env, ctx) {
		try {
			const auth = await authRoute(request, env);
			if (auth) return auth;
			const repository = await platformRoute(request, env, ctx);
			if (repository) return repository;
			return await route(request, env);
		} catch (e) {
			if (e instanceof HttpError || e instanceof ControllerError || e instanceof CoordinationError)
				return json({ error: e.message }, e.status);
			const message = (e as Error)?.message ?? String(e);
			// Durable Object RPC can serialize a domain error as a plain Error.
			const status = /unknown flight|unknown mission|no congestion|not part of these changes/i.test(message)
				? 404
				: /invalid flight plan|needs one of|invalid.*instruction/i.test(message)
					? 400
					: /cannot land|try again in|nothing to reroute|no waiting scope|has not filed a plan|unknown instruction|no plan|no held|no workspace|no repository yet|baseline refresh hit a Git conflict|validation|approved|is (landed|cancelled|failed|lost)/i.test(
								message,
							)
						? 409
						: 500;
			if (status === 500) console.error("cruce api error", message);
			return json({ error: message }, status);
		}
	},

	/** Artifacts repository events (Queues event subscriptions) → the owning project's tower. */
	async queue(batch, env) {
		for (const msg of batch.messages) {
			const evt = msg.body;
			if (!isArtifactsEvent(evt)) {
				msg.ack();
				continue;
			}
			// The queue receives events for every namespace in the account; only ours are routed.
			if (evt.source.namespace !== env.ARTIFACTS_NAMESPACE) {
				msg.ack();
				continue;
			}
			const repo = evt.source.repoName;
			const directory = env.PROJECT_DIRECTORY?.getByName("projects");
			if (directory) {
				const native = (await directory.projects()).find(
					(p) => p.active && (repo === p.artifactRepository || repo.startsWith(`${p.artifactRepository}--`)),
				);
				if (native) {
					await env.CONTROL_TOWER.getByName(native.id).projectArtifactEvent(native);
					msg.ack();
					continue;
				}
			}
			const project = [...PROJECTS]
				.sort((a, b) => b.repo.length - a.repo.length)
				.find((p) => repo === p.repo || repo.startsWith(`${p.repo}--`));
			if (project) await tower(env, project.id).artifactEvent(project.id, evt);
			msg.ack();
		}
	},
} satisfies ExportedHandler<Env>;

const api = {
	async fetch(request, env, ctx) {
		try {
			const auth = ctx as ExecutionContext & { props: AuthProps; auth: { scope: string[] } };
			if (!auth.auth?.scope.includes("coordination")) return json({ error: "Coordination scope required" }, 403);
			return (await platformRoute(request, env, ctx, auth.props)) ?? json({ error: "Not found" }, 404);
		} catch (error) {
			return json({ error: (error as Error).message }, error instanceof CoordinationError ? error.status : 400);
		}
	},
} satisfies ExportedHandler<Env>;

export default {
	fetch(request, env, ctx) {
		return env.OAUTH_KV
			? oauthProvider(api, legacy, env.CRUCE_PUBLIC_ORIGIN ?? "https://cruce.acltabontabon.workers.dev").fetch(request, env, ctx)
			: legacy.fetch!(request, env, ctx);
	},
	queue: legacy.queue,
} satisfies ExportedHandler<Env>;
