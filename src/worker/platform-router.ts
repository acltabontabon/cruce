import { z } from "zod";
import { CoordinationError } from "../core/workstreams.ts";
import { CommandInput, TOOLS } from "../shared/coordination.ts";
import { type Actor, PlatformCommandInput } from "../shared/platform.ts";
import { type AuthEnv, type AuthProps, consoleIdentity, validateIdentity } from "./auth.ts";
import type { ControlTower } from "./control-tower.ts";
import { type MachineCommand, remoteMcp } from "./mcp.ts";
import type { ProjectDirectory } from "./project-directory.ts";
export interface PlatformEnv extends AuthEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	PROJECT_DIRECTORY: DurableObjectNamespace<ProjectDirectory>;
}
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
async function input(request: Request) {
	const text = await request.text();
	if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new CoordinationError(413, "Bounded request limit exceeded");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new CoordinationError(400, "Invalid JSON");
	}
}
export async function platformRoute(
	request: Request,
	env: PlatformEnv,
	ctx: ExecutionContext,
	props?: AuthProps,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname.startsWith("/mcp/")) url.pathname = url.pathname.replace("/mcp/", "/api/projects/");
	if (!url.pathname.startsWith("/api/projects") && url.pathname !== "/mcp" && url.pathname !== "/coordination") return;
	const directory = env.PROJECT_DIRECTORY?.getByName("projects");
	if (!directory) throw new CoordinationError(503, "Project directory not configured");
	const identity = props ? await validateIdentity(props, env) : await consoleIdentity(request, env);
	const authorize = async (id: string) => {
		const project = await directory.project(id),
			principal = await directory.principal(identity, project);
		return { project, actor: { ...principal, kind: props ? "agent" : "human" } as Actor, tower: env.CONTROL_TOWER.getByName(id) };
	};
	const execute = async (cmd: MachineCommand) => {
		const { project, actor, tower } = await authorize(cmd.projectId);
		return (TOOLS as readonly string[]).includes(cmd.tool)
			? tower.coordination(project, CommandInput.parse(cmd), actor)
			: tower.nativeCommand(project, PlatformCommandInput.parse(cmd), actor);
	};
	if (url.pathname === "/mcp") return remoteMcp(execute)(request, env, ctx);
	if (url.pathname === "/coordination" || url.pathname === "/api/projects/command") {
		if (request.method !== "POST") throw new CoordinationError(405, "POST required");
		const raw = (await input(request)) as { tool?: string },
			schema = (TOOLS as readonly string[]).includes(raw.tool ?? "") ? CommandInput : PlatformCommandInput;
		return json(await execute(schema.parse(raw) as MachineCommand));
	}
	if (url.pathname === "/api/projects" && request.method === "GET") {
		const allowed = [];
		for (const project of await directory.projects())
			try {
				await directory.principal(identity, project);
				allowed.push({ ...project, members: undefined });
			} catch {}
		return json(allowed);
	}
	if (url.pathname === "/api/projects" && request.method === "POST") {
		if (props) throw new CoordinationError(403, "Human project creation required");
		const body = z.object({ name: z.string().min(1).max(200), idempotencyKey: z.string().min(1).max(200) }).parse(await input(request));
		const project = await directory.create(identity, body.name, body.idempotencyKey);
		return json(project);
	}
	const id = url.searchParams.get("projectId");
	if (!id) throw new CoordinationError(400, "Project identity required");
	if (url.pathname === "/api/projects/access") {
		if (request.method !== "POST") throw new CoordinationError(405, "POST required");
		if (props) throw new CoordinationError(403, "Human governance required");
		const body = z
			.object({
				expectedVersion: z.number().int().min(1),
				name: z.string().min(1).max(200).optional(),
				active: z.boolean().optional(),
				member: z.object({ id: z.string().min(1).max(200), role: z.enum(["maintainer", "contributor", "observer", "remove"]) }).optional(),
			})
			.parse(await input(request));
		return json(await directory.update(identity, id, body.expectedVersion, body));
	}
	const { project, actor, tower } = await authorize(id);
	if (url.pathname === "/api/projects/snapshot") {
		if (request.method !== "GET") throw new CoordinationError(405, "GET required");
		return json(await tower.projectSnapshot(project, actor));
	}
	if (url.pathname === "/api/projects/export") {
		if (request.method !== "GET") throw new CoordinationError(405, "GET required");
		const source = await tower.exportSource(project, actor);
		return new Response(source.pack.slice().buffer, {
			headers: { "content-type": "application/x-git-packed-objects", "x-cruce-revision": source.head, "cache-control": "no-store" },
		});
	}
	if (url.pathname === "/api/projects/override") {
		if (request.method !== "POST") throw new CoordinationError(405, "POST required");
		if (props) throw new CoordinationError(403, "Human governance required");
		const o = z
			.object({
				workstreamId: z.string(),
				resources: z.array(z.string()).min(1).max(100),
				reason: z.string().min(1).max(1000),
				fingerprint: z.string().max(100000),
				expiresAt: z.number(),
			})
			.parse(await input(request));
		return json(await tower.projectOverride(project, actor, o.workstreamId, o.resources, o.reason, o.fingerprint, o.expiresAt));
	}
	throw new CoordinationError(404, "Unknown project operation");
}
