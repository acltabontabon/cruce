import { DemoCommand, HumanCommand, PROJECTS, ProtocolRequest } from "../shared/api.ts";
import type { ControlTower } from "./control-tower.ts";
import { isArtifactsEvent } from "./event-subscriptions.ts";

export { ControlTower } from "./control-tower.ts";

interface Env {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	CRUCE_SECRET?: string;
	CRUCE_ADMIN_TOKEN?: string;
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

/** Per-Flight bearer token for the agent protocol (HMAC; not a Git credential). */
export async function flightToken(secret: string, projectId: string, flightId: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`cruce:v1:${projectId}:${flightId}`));
	return btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function bearer(request: Request): string | undefined {
	const h = request.headers.get("authorization");
	return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function requireAdmin(request: Request, env: Env) {
	const token = bearer(request);
	if (!env.CRUCE_ADMIN_TOKEN || !token || !timingSafeEqualStr(token, env.CRUCE_ADMIN_TOKEN)) {
		throw new HttpError(401, "controller token required for live operations");
	}
}

async function body<T>(
	request: Request,
	schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
): Promise<T> {
	const raw = await request.json().catch(() => {
		throw new HttpError(400, "invalid JSON");
	});
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw new HttpError(400, parsed.error.message);
	return parsed.data;
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== "api") return new Response("Not found", { status: 404 });

	if (parts[1] === "health") return json({ ok: true, service: "cruce" });
	if (parts[1] !== "projects") throw new HttpError(404, "not found");
	if (parts.length === 2) return json(PROJECTS);

	const project = PROJECTS.find((p) => p.id === parts[2]);
	if (!project) throw new HttpError(404, "unknown project");
	const stub = tower(env, project.id);
	const action = parts[3];

	if (!action && request.method === "GET") return json(await stub.snapshot(project.id));

	if (action === "ws") {
		const headers = new Headers(request.headers);
		headers.set("x-cruce-project", project.id);
		return stub.fetch(new Request(request, { headers }));
	}

	if (action === "demo" && request.method === "POST") {
		if (project.mode !== "demo") throw new HttpError(400, "not a demo project");
		return json(await stub.demo(project.id, await body(request, DemoCommand)));
	}

	if (action === "commands" && request.method === "POST") {
		if (project.mode === "live") requireAdmin(request, env);
		const cmd = await body(request, HumanCommand);
		return json(await stub.command(project.id, cmd, project.mode === "live" ? "controller" : "you"));
	}

	if (action === "history" && request.method === "GET") {
		const target = url.searchParams.get("target") ?? "canonical";
		if (!/^(canonical|F-\d{3})$/.test(target)) throw new HttpError(400, "bad target");
		return json(await stub.history(project.id, target));
	}

	if (action === "audit" && request.method === "GET") return json(await stub.auditLog(project.id));

	// Agent protocol: /api/projects/:p/flights/:flightId/protocol
	if (action === "flights" && parts[5] === "protocol" && request.method === "POST") {
		const flightId = parts[4];
		if (!/^F-\d{3}$/.test(flightId)) throw new HttpError(400, "bad flight id");
		if (!env.CRUCE_SECRET) throw new HttpError(503, "agent protocol disabled (no CRUCE_SECRET)");
		const presented = bearer(request);
		const expected = await flightToken(env.CRUCE_SECRET, project.id, flightId);
		if (!presented || !timingSafeEqualStr(presented, expected)) throw new HttpError(401, "invalid flight token");
		return json(await stub.protocol(project.id, flightId, await body(request, ProtocolRequest)));
	}

	throw new HttpError(404, "not found");
}

export default {
	async fetch(request, env) {
		try {
			return await route(request, env);
		} catch (e) {
			if (e instanceof HttpError) return json({ error: e.message }, e.status);
			const message = (e as Error)?.message ?? String(e);
			const status = /cannot land|Unknown flight|No congestion|Invalid flight plan|needs one of/.test(message) ? 409 : 500;
			console.error("cruce api error", message);
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
			const repo = evt.source.repoName;
			const project = [...PROJECTS]
				.sort((a, b) => b.repo.length - a.repo.length)
				.find((p) => repo === p.repo || repo.startsWith(`${p.repo}--`));
			if (project) await tower(env, project.id).artifactEvent(project.id, evt);
			msg.ack();
		}
	},
} satisfies ExportedHandler<Env>;
