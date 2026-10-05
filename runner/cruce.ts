#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_AGENT_SCOPES } from "../src/core/capabilities.ts";
import type { Command, RepositorySnapshot, Session } from "../src/shared/platform.ts";
import { CRUCE_INSTRUCTIONS, CRUCE_TOOLS, toolByName, toolInputShape } from "../src/shared/tools.ts";
import { CRUCE_VERSION } from "../src/shared/version.ts";
import { configureClient } from "./client-config.ts";
import {
	cleanupExecution,
	context,
	createExecution,
	observeChanges,
	releaseCheckout,
	reserveCheckout,
	stateDirectory,
} from "./execution.ts";
import { git, packRevision, pipeGit } from "./local-git.ts";
import { Credentials, login } from "./oauth.ts";

interface Connection {
	mode?: "read" | "write";
	client?: string;
	server: string;
	workspaceId: string;
	repositoryId: string;
	humanToken?: string;
	sessionId?: string;
	baseRevision?: string;
	publishedRevision?: string;
	directory?: string;
	owned?: boolean;
	pending?: { fingerprint: string; command: Command };
}
const args = process.argv.slice(2),
	option = (key: string) => {
		const i = args.indexOf(`--${key}`);
		return i < 0 ? undefined : args[i + 1];
	};
const cwd = resolve(option("cwd") ?? process.cwd());
async function main() {
	const operation = args[0] ?? "help";
	if (operation === "help" || args.includes("--help")) {
		process.stdout.write(
			"Cruce — Workspace → Repository → Session\n\ncruce connect --workspace ID --repository ID --server URL [--client codex|claude|cursor]\ncruce human --workspace ID --repository ID --server URL\ncruce start --title TEXT [--read]\ncruce mcp [--client TOOL]\ncruce watch\ncruce publish [--title TEXT]\ncruce refresh\ncruce resume   reattach a prepared session\ncruce report-ref --ref BRANCH\ncruce end [--cleanup]\ncruce checkout --workspace ID --repository ID --server URL --directory EMPTY_DIRECTORY\n",
		);
		return;
	}
	const checkout = operation === "checkout";
	if (checkout) {
		const target = resolve(option("directory") ?? "");
		if (!option("directory")) throw new Error("Choose an empty directory");
		await mkdir(target, { recursive: true });
		if ((await readdir(target)).length) throw new Error("Checkout requires an empty directory");
		await git(target, ["init"]);
	}
	const root = checkout ? resolve(option("directory")!) : cwd;
	let configFile = join(await stateDirectory(root), "connection.json");
	const connection: Connection = await readFile(configFile, "utf8")
		.then(JSON.parse)
		.catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
			return {
				server: option("server") ?? "https://cruce.acltabontabon.workers.dev",
				workspaceId: option("workspace") ?? "",
				repositoryId: option("repository") ?? "",
			};
		});
	if (operation === "mcp" && !connection.owned) {
		// Every bridge process owns its session state. The repository connection remains shareable.
		configFile = join(await stateDirectory(root), `agent-${randomUUID()}.json`);
		delete connection.sessionId;
		delete connection.directory;
		delete connection.baseRevision;
		delete connection.publishedRevision;
		delete connection.pending;
	}
	connection.client = option("client") ?? connection.client ?? "agent";
	connection.server = (option("server") ?? connection.server).replace(/\/$/, "");
	connection.workspaceId = option("workspace") ?? connection.workspaceId;
	connection.repositoryId = option("repository") ?? connection.repositoryId;
	const url = new URL(connection.server);
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Use HTTPS");
	if (!connection.workspaceId || !connection.repositoryId) throw new Error("Choose a workspace and repository ID from Cruce");
	const save = async () => {
		await writeFile(configFile, JSON.stringify(connection, null, 2), { mode: 0o600 });
		if (connection.directory && connection.directory !== root)
			await writeFile(join(await stateDirectory(connection.directory), "connection.json"), JSON.stringify(connection, null, 2), {
				mode: 0o600,
			});
	};
	const send = async (path: string, body: unknown, token?: string) => {
		const response = await fetch(`${connection.server}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify(body),
		});
		const data = (await response.json()) as Record<string, unknown>;
		if (!response.ok) throw Object.assign(new Error(String(data.error ?? "Cruce request failed")), { status: response.status });
		return data;
	};
	if (operation === "human") {
		const pair = await send("/mcp?terminal=start", {
			workspaceId: connection.workspaceId,
			repositoryId: connection.repositoryId,
			sessionId: connection.sessionId,
		});
		process.stderr.write(`Authorize this terminal session in your browser:\n${pair.url}\n`);
		for (let i = 0; i < 150; i++) {
			const result = await send("/mcp?terminal=poll", { code: pair.code, proof: pair.proof });
			if (result.token) {
				connection.humanToken = String(result.token);
				connection.directory = root;
				await save();
				process.stdout.write("Terminal authorized. Run cruce start --title TEXT.\n");
				return;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		throw new Error("Terminal authorization timed out");
	}
	const clientName = connection.client,
		credentials = new Credentials(connection.server, clientName);
	await credentials.load();
	if (operation === "connect" || checkout) {
		delete connection.humanToken;
		await login(connection.server, credentials, DEFAULT_AGENT_SCOPES);
	}
	let remote: Client | undefined;
	if (!connection.humanToken) {
		remote = new Client({ name: `cruce-${clientName}-bridge`, version: CRUCE_VERSION });
		await remote.connect(new StreamableHTTPClientTransport(new URL(`${connection.server}/mcp`), { authProvider: credentials }));
	}
	const call = async (command: Command): Promise<unknown> => {
		if (connection.humanToken) return send("/mcp?terminal=command", command, connection.humanToken);
		const { tool, ...parameters } = command;
		const response = await remote!.callTool({ name: tool, arguments: parameters });
		if (response.isError)
			throw Object.assign(new Error(response.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")), {
				status: (response.structuredContent as { status?: number } | undefined)?.status,
			});
		return response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === "text")?.text ?? "{}");
	};
	let queue: Promise<unknown> = Promise.resolve();
	const execute = (raw: Partial<Command> & { tool: string }) => {
		const next = queue.then(async () => {
			const tool = toolByName(raw.tool);
			if (!tool) throw new Error("Unknown Cruce tool");
			const command: Command = {
				workspaceId: connection.workspaceId,
				repositoryId: connection.repositoryId,
				sessionId: connection.sessionId,
				...raw,
			};
			if (raw.tool === "start_session") {
				if (connection.sessionId) throw new Error("End the current session before starting another");
				command.baseRevision ??= await git(root, ["rev-parse", "HEAD"]);
				command.title ??= option("title") ?? "Local work";
				command.mode ??= args.includes("--read") ? "read" : "write";
				delete command.sessionId;
			}
			const directory = connection.directory ?? root;
			if (raw.tool === "report_change") {
				if (!connection.baseRevision) throw new Error("Start a session first");
				Object.assign(command, await observeChanges(directory, connection.baseRevision));
			}
			if (raw.tool === "publish_revision") {
				if (!connection.baseRevision) throw new Error("Start a session first");
				const packed = await packRevision(directory, connection.publishedRevision ?? connection.baseRevision);
				command.revision = packed.revision;
				command.pack = packed.pack;
			}
			const fingerprint = JSON.stringify(command);
			if (tool.mutation) {
				if (connection.pending && connection.pending.command.tool !== command.tool)
					throw new Error("A previous mutation has an uncertain outcome. Retry that operation before starting another.");
				if (connection.pending) Object.assign(command, connection.pending.command);
				command.idempotencyKey = connection.pending?.command.idempotencyKey ?? randomUUID();
				connection.pending = { fingerprint, command };
				await save();
			}
			let result: Record<string, unknown>;
			try {
				result = (await call(command)) as Record<string, unknown>;
			} catch (error) {
				// Explicit authorization/validation rejection is a known outcome. Network/provider
				// failures keep the operation identity until the caller reconciles the attempt.
				if ([400, 401, 403, 404, 405, 409, 413].includes((error as { status: number }).status)) {
					delete connection.pending;
					await save();
				}
				throw error;
			}
			if (tool.mutation) {
				delete connection.pending;
				await save();
			}
			if (raw.tool === "start_session") {
				const session = result as unknown as Session;
				connection.sessionId = session.id;
				connection.baseRevision = session.baseRevision;
				connection.mode = session.mode;
				await save();
				if (session.mode === "write") {
					const made = connection.humanToken
						? { directory: root, execution: await context(root, session.id, false) }
						: await createExecution(root, session.id, session.baseRevision);
					await reserveCheckout(made.directory, session.id);
					connection.directory = made.directory;
					connection.owned = made.execution.owned;
					await save();
					const attach: Command = {
						tool: "attach_session",
						workspaceId: connection.workspaceId,
						repositoryId: connection.repositoryId,
						sessionId: session.id,
						execution: made.execution,
						idempotencyKey: `attach-${session.id}`,
					};
					await call(attach);
					return { ...result, directory: made.directory, instruction: "Use this isolated directory for all session work." };
				}
			}
			if (raw.tool === "publish_revision") {
				connection.publishedRevision = String(result.revision);
				await save();
			}
			if (raw.tool === "end_session") {
				const sessionId = connection.sessionId!;
				await releaseCheckout(directory, sessionId);
				const cleanup = args.includes("--cleanup") && connection.owned;
				const retained = connection.publishedRevision ?? connection.baseRevision!;
				delete connection.sessionId;
				delete connection.baseRevision;
				delete connection.directory;
				delete connection.owned;
				await save();
				if (cleanup) await cleanupExecution(directory, sessionId, retained);
			}
			return result;
		});
		queue = next.catch(() => {});
		return next;
	};
	try {
		if (operation === "connect") {
			await call({ tool: "get_repository", workspaceId: connection.workspaceId, repositoryId: connection.repositoryId });
			await save();
			const client = option("client");
			if (client && ["codex", "claude", "cursor"].includes(client))
				await configureClient(root, client as "codex" | "claude" | "cursor", fileURLToPath(new URL("./cruce.mjs", import.meta.url)));
			process.stdout.write("Connected. Start work through Cruce MCP or cruce start.\n");
			return;
		}
		if (operation === "resume") {
			if (!connection.sessionId) throw new Error("No prepared session to resume");
			let directory = connection.directory;
			if (!directory) {
				const made = connection.humanToken
					? { directory: root, execution: await context(root, connection.sessionId, false) }
					: await createExecution(root, connection.sessionId, connection.baseRevision!);
				directory = made.directory;
				connection.directory = directory;
				connection.owned = made.execution.owned;
				await save();
			}
			await reserveCheckout(directory, connection.sessionId);
			const execution = await context(directory, connection.sessionId, connection.owned ?? false);
			await call({
				tool: "attach_session",
				workspaceId: connection.workspaceId,
				repositoryId: connection.repositoryId,
				sessionId: connection.sessionId,
				execution,
				idempotencyKey: `attach-${connection.sessionId}`,
			});
			process.stdout.write(`Session attached at ${directory}\n`);
			return;
		}
		if (operation === "report-ref") {
			const ref = option("ref");
			if (!ref) throw new Error("Choose --ref BRANCH");
			const revision = await git(connection.directory ?? root, ["rev-parse", `refs/heads/${ref}`]);
			process.stdout.write(`${JSON.stringify(await execute({ tool: "report_ref", ref, revision }))}\n`);
			return;
		}
		if (operation === "refresh" || checkout) {
			const snapshot = (await call({
				tool: "get_repository",
				workspaceId: connection.workspaceId,
				repositoryId: connection.repositoryId,
			})) as RepositorySnapshot;
			if (snapshot.repository.source.kind === "local")
				throw new Error("Fetch your existing remote with normal Git. Cruce does not manage that remote.");
			const head = snapshot.sourceHead;
			if (!head) throw new Error("Hosted source not provisioned");
			const exported = (await call({
				tool: "export_revision",
				workspaceId: connection.workspaceId,
				repositoryId: connection.repositoryId,
				revision: head,
			})) as { pack: string };
			await pipeGit(root, ["index-pack", "--stdin"], Buffer.from(exported.pack, "base64"));
			await git(root, ["update-ref", "refs/cruce/source", head]);
			if (checkout) {
				await git(root, ["update-ref", `refs/heads/${snapshot.repository.defaultBranch}`, head]);
				await git(root, ["symbolic-ref", "HEAD", `refs/heads/${snapshot.repository.defaultBranch}`]);
				await git(root, ["checkout", snapshot.repository.defaultBranch]);
				await save();
			}
			process.stdout.write(`Source ${head} available at refs/cruce/source. Working changes preserved.\n`);
			return;
		}
		const heartbeat = () => {
			if (connection.sessionId)
				void execute({ tool: "heartbeat" })
					.then(() => (connection.mode === "read" ? undefined : execute({ tool: "report_change" })))
					.catch((e) => process.stderr.write(`${(e as Error).message}\n`));
		};
		if (operation === "mcp") {
			if (connection.humanToken) throw new Error("Agent MCP cannot use human terminal credentials; connect the agent separately");
			const server = new McpServer({ name: "Cruce local bridge", version: CRUCE_VERSION }, { instructions: CRUCE_INSTRUCTIONS });
			for (const tool of CRUCE_TOOLS) {
				const { workspaceId: _, repositoryId: __, sessionId: ___, idempotencyKey: ____, ...shape } = toolInputShape(tool);
				server.registerTool(tool.name, { description: tool.description, inputSchema: shape }, async (values) => {
					try {
						const result = await execute({ ...values, tool: tool.name });
						return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
					} catch (e) {
						return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
					}
				});
			}
			const timer = setInterval(heartbeat, 30000);
			timer.unref();
			await server.connect(new StdioServerTransport());
			await new Promise<void>((done) => {
				process.once("SIGTERM", () => {
					clearInterval(timer);
					done();
				});
				process.once("SIGINT", () => {
					clearInterval(timer);
					done();
				});
			});
			await server.close();
			return;
		}
		if (operation === "watch") {
			heartbeat();
			const timer = setInterval(heartbeat, 30000);
			await new Promise<void>((done) => {
				process.once("SIGINT", () => {
					clearInterval(timer);
					done();
				});
			});
			return;
		}
		const tool =
			operation === "start"
				? "start_session"
				: operation === "publish"
					? "publish_revision"
					: operation === "end"
						? "end_session"
						: operation === "check"
							? "get_repository"
							: undefined;
		if (!tool) throw new Error("Unknown command; run cruce help");
		process.stdout.write(`${JSON.stringify(await execute({ tool, ...(option("title") ? { title: option("title") } : {}) }), null, 2)}\n`);
	} finally {
		await remote?.close();
	}
}
main().catch((error) => {
	process.stderr.write(`${(error as Error).message}\n`);
	process.exitCode = 1;
});
