#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	auth,
	Client,
	type OAuthClientProvider,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { type Command, CommandInput, type Decision, PARTICIPATION, READ_TOOLS, TOOLS } from "../src/shared/coordination.ts";
import { PLATFORM_READ_TOOLS, PLATFORM_TOOLS, PlatformCommandInput } from "../src/shared/platform.ts";
import { configureClient } from "./client-config.ts";
import { git, observe, pipeGit, workspace } from "./local-git.ts";

interface Connection {
	missionId?: string;
	missionVersion?: number;
	server: string;
	projectId: string;
	workstreamId?: string;
	sessionId?: string;
	workstreamVersion?: number;
	planVersion?: number;
}
const args = process.argv.slice(2),
	option = (key: string) => {
		const index = args.indexOf(`--${key}`);
		return index < 0 ? undefined : args[index + 1];
	},
	cwd = resolve(option("cwd") ?? process.cwd()),
	connectionFile = join(cwd, ".cruce/connection.json");
async function read<T>(path: string, fallback: T) {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return fallback;
	}
}
async function save(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}
class Credentials implements OAuthClientProvider {
	redirectUrl: string | undefined;
	clientMetadata = {
		client_name: "Cruce local coordination bridge",
		redirect_uris: [] as string[],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none" as const,
	};
	data: { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; verifier?: string; state?: string } = {};
	path: string;
	constructor(server: string) {
		this.path = join(homedir(), ".config/cruce", `${Buffer.from(new URL(server).origin).toString("base64url")}.json`);
	}
	async load() {
		this.data = await read(this.path, {});
	}
	clientInformation() {
		return this.data.client;
	}
	async saveClientInformation(client: StoredOAuthClientInformation) {
		this.data.client = client;
		await save(this.path, this.data);
	}
	tokens() {
		return this.data.tokens;
	}
	async saveTokens(tokens: StoredOAuthTokens) {
		this.data.tokens = tokens;
		await save(this.path, this.data);
	}
	async saveCodeVerifier(verifier: string) {
		this.data.verifier = verifier;
		await save(this.path, this.data);
	}
	codeVerifier() {
		if (!this.data.verifier) throw new Error("No pending authorization");
		return this.data.verifier;
	}
	async state() {
		this.data.state = randomUUID();
		await save(this.path, this.data);
		return this.data.state;
	}
	redirectToAuthorization(url: URL) {
		process.stderr.write(`Open this sign-in link in your browser:\n${url.href}\n`);
	}
}
async function login(server: string, credentials: Credentials) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let complete!: (code: string, iss?: string) => void;
	const callback = new Promise<{ code: string; iss?: string }>((resolve) => {
		complete = (code, iss) => resolve({ code, iss });
	});
	const listener = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/callback" || url.searchParams.get("state") !== credentials.data.state || !url.searchParams.get("code")) {
			response.writeHead(400);
			response.end("Sign-in state mismatch");
			return;
		}
		complete(url.searchParams.get("code") as string, url.searchParams.get("iss") ?? undefined);
		response.end("Connected to Cruce. You can close this tab.");
	});
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Cannot open OAuth callback");
	credentials.redirectUrl = `http://127.0.0.1:${address.port}/callback`;
	credentials.clientMetadata.redirect_uris = [credentials.redirectUrl];
	// Registration binds the exact callback. Re-register when an ephemeral callback changes.
	credentials.data.client = undefined;
	try {
		const result = await auth(credentials, {
			serverUrl: `${server}/mcp`,
			scope: "coordination offline_access",
			forceReauthorization: true,
		});
		if (result !== "AUTHORIZED") {
			const { code, iss } = await Promise.race([
				callback,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("Sign-in timed out")), 300000);
				}),
			]);
			await auth(credentials, { serverUrl: `${server}/mcp`, authorizationCode: code, iss });
		}
	} finally {
		clearTimeout(timeout);
		listener.close();
	}
}
async function main() {
	const operation = args[0] ?? "help";
	if (operation === "help" || args.includes("--help")) {
		process.stdout.write(
			"cruce connect --project ID --client codex|claude|cursor [--server URL]\ncruce checkout --project ID --directory NEW_DIRECTORY\ncruce mcp --client TOOL\ncruce refresh\ncruce check\ncruce release\n",
		);
		return;
	}
	const connection = await read<Connection>(connectionFile, {
		server: option("server") ?? option("url") ?? "https://cruce.acltabontabon.workers.dev",
		projectId: option("project") ?? "",
	});
	connection.server = (option("server") ?? option("url") ?? connection.server).replace(/\/$/, "");
	connection.projectId = option("project") ?? connection.projectId;
	const origin = new URL(connection.server);
	if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Use HTTPS for Cruce");
	const credentials = new Credentials(connection.server);
	await credentials.load();
	if (operation === "connect" || operation === "checkout") await login(connection.server, credentials);
	if (!connection.projectId) throw new Error("Choose the native project ID; no external Git provider is required");
	if (operation === "checkout") {
		const target = option("directory");
		if (!target) throw new Error("Choose a new directory for source checkout");
		const directory = resolve(target);
		await mkdir(directory, { recursive: true });
		if ((await readdir(directory)).length) throw new Error("Checkout requires an empty directory; existing work is preserved");
		const response = await fetch(`${connection.server}/mcp/export?projectId=${encodeURIComponent(connection.projectId)}`, {
			headers: { authorization: `Bearer ${credentials.tokens()?.access_token}` },
		});
		if (!response.ok) throw new Error("Source export denied or unavailable");
		const head = response.headers.get("x-cruce-revision");
		if (!head || !/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid immutable source revision");
		await git(directory, ["init"]);
		await pipeGit(directory, ["index-pack", "--stdin"], Buffer.from(await response.arrayBuffer()));
		await git(directory, ["update-ref", "refs/heads/main", head]);
		await git(directory, ["update-ref", "refs/cruce/accepted", head]);
		await git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		await git(directory, ["checkout", "main"]);
		await save(join(directory, ".cruce/connection.json"), connection);
		process.stdout.write(`Source checked out at ${head}. Run cruce connect --cwd ${directory} --client TOOL to configure participation.\n`);
		return;
	}
	const transport = new StreamableHTTPClientTransport(new URL(`${connection.server}/mcp`), { authProvider: credentials }),
		remote = new Client({ name: "cruce-local-bridge", version: "0.3.0" });
	await remote.connect(transport);
	const refreshSource = async () => {
		await remote.callTool({ name: "get_project_context", arguments: { projectId: connection.projectId } });
		const response = await fetch(`${connection.server}/mcp/export?projectId=${encodeURIComponent(connection.projectId)}`, {
			headers: { authorization: `Bearer ${credentials.tokens()?.access_token}` },
		});
		const head = response.headers.get("x-cruce-revision");
		if (!response.ok || !head || !/^[a-f0-9]{40}$/.test(head)) throw new Error("Accepted source unavailable");
		await pipeGit(cwd, ["index-pack", "--stdin"], Buffer.from(await response.arrayBuffer()));
		await git(cwd, ["update-ref", "refs/cruce/accepted", head]);
		return {
			revision: head,
			gitRef: "refs/cruce/accepted",
			nextAction:
				"Inspect accepted source. Reconcile with your draft using normal Git tools, preserve existing changes, then amend the mission plan. Fetching does not change the working tree.",
		};
	};
	if (operation === "connect") {
		await refreshSource();
		await workspace(cwd);
		await save(connectionFile, connection);
		const client = option("client") ?? "codex";
		if (!["codex", "claude", "cursor"].includes(client)) throw new Error("Select codex, claude or cursor");
		const configured = await configureClient(cwd, client as "codex" | "claude" | "cursor", fileURLToPath(import.meta.url));
		process.stdout.write(`${JSON.stringify(configured, null, 2)}\nConnected to native Cruce. Continue using your coding tool normally.\n`);
		await remote.close();
		return;
	}
	if (operation === "refresh") {
		process.stdout.write(`${JSON.stringify(await refreshSource(), null, 2)}\n`);
		await remote.close();
		return;
	}
	let queue: Promise<unknown> = Promise.resolve();
	const execute = async (input: Record<string, unknown> & { tool: string }) => {
		const native = (PLATFORM_TOOLS as readonly string[]).includes(input.tool),
			readOnly = native ? PLATFORM_READ_TOOLS.has(input.tool) : READ_TOOLS.has(input.tool as Command["tool"]);
		const common = { projectId: connection.projectId, ...(!readOnly ? { idempotencyKey: randomUUID() } : {}), ...input };
		const data = native
			? {
					missionId: connection.missionId,
					sessionId: connection.sessionId,
					expectedVersion: connection.missionVersion,
					expectedPlanVersion: connection.planVersion,
					...common,
				}
			: {
					workstreamId: connection.workstreamId,
					sessionId: connection.sessionId,
					expectedVersion: connection.workstreamVersion,
					expectedPlanVersion: connection.planVersion,
					...common,
				};
		if (["register_intent", "attach_workstream", "update_intent", "report_scope", "accept_mission"].includes(input.tool))
			Object.assign(data, {
				workspace: await workspace(cwd),
				agent: {
					tool: option("client") ?? "terminal",
					instance: process.env.CRUCE_AGENT_INSTANCE ?? `${process.pid}:${cwd}`,
					role: "writer",
				},
			});
		if (input.tool === "report_change") Object.assign(data, { observation: await observe(cwd, (await workspace(cwd)).base) });
		const cmd = native ? PlatformCommandInput.parse(data) : CommandInput.parse(data);
		const response = await remote.callTool({ name: input.tool, arguments: cmd });
		if (response.isError) throw new Error(response.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
		const result = (response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === "text")?.text ?? "{}")) as Record<
			string,
			unknown
		>;
		const decision = (result.coordination ?? result) as Partial<Decision> & { sessionId?: string };
		if (decision.workstreamId) {
			connection.workstreamId = decision.workstreamId;
			connection.sessionId = decision.sessionId ?? connection.sessionId;
			if (decision.workstreamVersion !== undefined) connection.workstreamVersion = decision.workstreamVersion;
			if (decision.planVersion !== undefined) connection.planVersion = decision.planVersion;
		}
		const mission = result.mission as { id?: string; version?: number } | undefined;
		if (mission?.id) {
			connection.missionId = mission.id;
			connection.missionVersion = mission.version;
		}
		await save(connectionFile, connection);
		return result;
	};
	const serialized = (input: Record<string, unknown> & { tool: string }) => {
		const next = queue.then(() => execute(input));
		queue = next.catch(() => {});
		return next;
	};
	if (operation === "mcp") {
		const server = new McpServer({ name: "Cruce local bridge", version: "0.3.0" }, { instructions: PARTICIPATION });
		server.registerTool(
			"refresh_source",
			{
				description: "Fetch accepted source objects into refs/cruce/accepted. Does not change or discard working-tree code.",
				inputSchema: {},
			},
			async () => {
				try {
					const result = await refreshSource();
					return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
				} catch (error) {
					return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
				}
			},
		);
		for (const tool of [...TOOLS, ...PLATFORM_TOOLS]) {
			const native = (PLATFORM_TOOLS as readonly string[]).includes(tool),
				inputSchema = native
					? PlatformCommandInput.omit({ tool: true, projectId: true, sessionId: true }).partial().shape
					: CommandInput.omit({ tool: true, projectId: true, sessionId: true }).partial().shape;
			server.registerTool(tool, { description: tool.replaceAll("_", " "), inputSchema }, async (input: Record<string, unknown>) => {
				try {
					const result = await serialized({ ...input, tool });
					return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
				} catch (e) {
					return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
				}
			});
		}
		const timer = setInterval(() => {
			if (connection.workstreamId)
				void serialized({ tool: "report_change" })
					.then(() => serialized({ tool: "check_coordination" }))
					.catch((e) => process.stderr.write(`${(e as Error).message}\n`));
		}, 30000);
		timer.unref();
		const release = () => {
			clearInterval(timer);
			void serialized({ tool: "release_scope" }).finally(() => process.exit());
		};
		process.on("SIGTERM", release);
		process.on("SIGINT", release);
		await server.connect(new StdioServerTransport());
		return;
	}
	if (operation === "check") {
		if (!connection.workstreamId) {
			process.stdout.write("No accepted mission is attached; source coordination has limited visibility.\n");
			process.exitCode = 2;
		} else {
			await serialized({ tool: "report_change" });
			const d = await serialized({ tool: "request_publish" });
			process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
			process.exitCode = d.publication === "PROCEED" ? 0 : 1;
		}
	} else if (operation === "release") await serialized({ tool: "release_scope" });
	else throw new Error(`Unknown command ${operation}`);
	await remote.close();
}
void main().catch((error) => {
	process.stderr.write(`${(error as Error).message}\n`);
	process.exitCode = 1;
});
