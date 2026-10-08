#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_AGENT_SCOPES } from "../src/core/capabilities.ts";
import type { Command, ExecutionContext, RepositorySnapshot, Workspace } from "../src/shared/platform.ts";
import { CRUCE_INSTRUCTIONS, CRUCE_PROMPTS, CRUCE_TOOLS, toolByName, toolInputShape } from "../src/shared/tools.ts";
import { CRUCE_VERSION } from "../src/shared/version.ts";
import { type CheckoutAddress, resolveCheckout } from "./checkout.ts";
import { bridgeCommand, configureClient, KNOWN_CLIENTS, type KnownClient } from "./client-config.ts";
import { coordinationContext, coordinationDetail, coordinationResource } from "./coordination.ts";
import {
	cleanupExecution,
	context,
	createExecution,
	observeChanges,
	releaseCheckout,
	reserveCheckout,
	stateDirectory,
} from "./execution.ts";
import { configureServerCredentials } from "./git-auth.ts";
import { configureFork, continueFromFork, serverOrigin } from "./git-remotes.ts";
import { git } from "./local-git.ts";
import { previewReconciliation } from "./merge-preview.ts";
import { Credentials, login } from "./oauth.ts";
import { withStateLock, writeState } from "./state-file.ts";
import { findWorkspaceState, registerWorkspaceState } from "./workspace-state.ts";

interface Connection {
	stateFile?: string;
	client?: string;
	server: string;
	namespaceId: string;
	repositoryId: string;
	humanToken?: string;
	workspaceId?: string;
	baseRevision?: string;
	publishedRevision?: string;
	integratedRevision?: string;
	directory?: string;
	owned?: boolean;
	execution?: ExecutionContext;
	attachKey?: string;
	hosted?: boolean;
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
			"Cruce — Git coordination for parallel agentic development\n\nOnce per machine:\ncruce login --server URL                          authorize Git for every repository you can access\ncruce connect --server URL --client claude|codex|cursor   connect a tool to every Cruce checkout\n\nIn a checkout:\ncruce human --namespace ID --repository ID --server URL   pair this terminal to work yourself\ncruce start --title TEXT\ncruce mcp [--server URL] [--client TOOL]\ncruce watch [--coordination]   emit changed coordination state for an external host\ncruce hint                     print workspaces behind canonical, for a client prompt hook\ncruce preview [--workspace ID]  check an exact-commit Git merge locally\ncruce publish [--title TEXT]\ncruce detach                   release this checkout; the workspace continues elsewhere\ncruce resume [--workspace ID]  reattach, or continue a workspace here from its pushed head\ncruce end [--cleanup]\n",
		);
		return;
	}
	if (operation === "login") {
		const server = option("server");
		if (!server) throw new Error("Choose --server URL");
		const origin = serverOrigin(server);
		// Git only clones and fetches canonical with this connection; workspace forks use the tool's own connection.
		const credentials = new Credentials(origin, "git");
		await credentials.load();
		await login(origin, credentials, ["cruce:read"]);
		await configureServerCredentials(origin);
		process.stdout.write(`Git authorized for ${origin}. Clone any repository you can access with the command shown in Cruce.\n`);
		return;
	}
	if (operation === "connect") {
		const server = option("server"),
			client = option("client");
		if (!server || !client) throw new Error("Choose --server URL and --client claude, codex or cursor");
		const origin = serverOrigin(server),
			credentials = new Credentials(origin, client);
		await credentials.load();
		await login(origin, credentials, DEFAULT_AGENT_SCOPES);
		// One read proves the new grant works before any tool settings change.
		const remote = new Client({ name: `cruce-${client}-bridge`, version: CRUCE_VERSION });
		await remote.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: credentials }));
		try {
			const checked = await remote.callTool({ name: "list_namespaces", arguments: {} });
			if (checked.isError) throw new Error("Cruce rejected the new connection; check your access and connect again");
		} finally {
			await remote.close();
		}
		const bridge = fileURLToPath(new URL("./cruce.mjs", import.meta.url));
		if (KNOWN_CLIENTS.includes(client as KnownClient)) {
			await configureClient(client as KnownClient, bridge, origin);
			process.stdout.write(`Connected ${client} to ${origin}. Restart it, then start it in any Cruce checkout.\n`);
		} else
			process.stdout.write(
				`Connected ${client} to ${origin}. Add this stdio MCP server to its user settings:\n${[process.execPath, ...bridgeCommand(bridge, origin, client)].join(" ")}\n`,
			);
		return;
	}
	const server = option("server") ? serverOrigin(option("server")!) : undefined;
	let root = cwd,
		address: CheckoutAddress | undefined;
	if (operation === "mcp" || operation === "hint") {
		// User-level tool settings start the bridge wherever the tool runs: bind to the checkout that tool works in.
		const candidates = [option("cwd"), process.env.CLAUDE_PROJECT_DIR, process.cwd()]
			.filter((d): d is string => !!d)
			.map((d) => resolve(d));
		for (const directory of new Set(candidates)) {
			address = await resolveCheckout(directory, server);
			if (address) {
				root = directory;
				break;
			}
		}
		if (!address) {
			if (operation === "mcp") await unboundBridge(server);
			return;
		}
	} else if (operation !== "human") address = await resolveCheckout(root, server);
	let configFile = join(await stateDirectory(root), "connection.json");
	const connection: Connection = await readFile(configFile, "utf8")
		.then(JSON.parse)
		.catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
			return {
				server: server ?? address?.server ?? "",
				namespaceId: option("namespace") ?? address?.namespaceId ?? "",
				repositoryId: option("repository") ?? address?.repositoryId ?? "",
			};
		});
	if (operation === "mcp" && (!connection.workspaceId || connection.humanToken)) {
		// Every bridge process owns its workspace state. The repository connection remains shareable; a terminal's
		// human credential never is: the bridge uses its tool's own connection.
		configFile = join(await stateDirectory(root), `agent-${randomUUID()}.json`);
		delete connection.humanToken;
		delete connection.workspaceId;
		delete connection.directory;
		delete connection.baseRevision;
		delete connection.publishedRevision;
		delete connection.execution;
		delete connection.pending;
	}
	connection.client = option("client") ?? connection.client ?? "agent";
	connection.server = (server ?? connection.server).replace(/\/$/, "");
	if (!connection.server) throw new Error("Choose --server URL");
	connection.namespaceId = option("namespace") ?? connection.namespaceId;
	connection.repositoryId = option("repository") ?? connection.repositoryId;
	if (connection.stateFile && connection.owned) configFile = connection.stateFile;
	connection.stateFile = configFile;
	const url = new URL(connection.server);
	if (url.username || url.password) throw new Error("Use a server URL without credentials");
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Use HTTPS");
	if (!connection.namespaceId || !connection.repositoryId)
		throw new Error("Run this in a Cruce checkout, or choose --namespace ID and --repository ID from Cruce");
	let defaultConfigFile = configFile;
	const repositoryConnection = {
		server: connection.server,
		namespaceId: connection.namespaceId,
		repositoryId: connection.repositoryId,
		client: connection.client,
		humanToken: connection.humanToken,
	};
	const tracked = new Set<string>();
	if (connection.workspaceId) tracked.add(connection.workspaceId);
	const save = async (copyDirectory = connection.directory) => {
		await writeState(configFile, connection);
		if (connection.workspaceId) await registerWorkspaceState(root, connection.workspaceId, configFile);
		if (copyDirectory) {
			const copy = join(await stateDirectory(copyDirectory), "connection.json");
			if (copy !== configFile) await writeState(copy, connection);
		}
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
			namespaceId: connection.namespaceId,
			repositoryId: connection.repositoryId,
			workspaceId: connection.workspaceId,
		});
		process.stderr.write(`Authorize this terminal workspace in your browser:\n${pair.url}\n`);
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
	/** Materialize and attach the workspace in this checkout, then fast-forward to its pushed fork head. */
	const attachHere = async (workspace: Pick<Workspace, "id" | "baseRevision">, continuing = false) => {
		let directory = connection.directory;
		if (!directory) {
			const made = connection.humanToken
				? { directory: root, execution: await context(root, workspace.id, false) }
				: await createExecution(root, workspace.id, workspace.baseRevision);
			directory = made.directory;
			connection.directory = directory;
			connection.owned = made.execution.owned;
			await save();
		}
		await reserveCheckout(directory, workspace.id);
		connection.execution = await context(directory, workspace.id, connection.owned ?? false);
		// One identity per attachment attempt: retries reuse it, a later re-attachment after detach does not.
		connection.attachKey ??= `attach-${workspace.id}-${randomUUID()}`;
		await save();
		const attached = (await call({
			tool: "attach_workspace",
			namespaceId: connection.namespaceId,
			repositoryId: connection.repositoryId,
			workspaceId: workspace.id,
			execution: connection.execution,
			idempotencyKey: connection.attachKey,
		})) as Workspace;
		delete connection.attachKey;
		connection.hosted = !!attached.fork;
		if (attached.fork) {
			const access = (await call({
				tool: "get_git_access",
				namespaceId: connection.namespaceId,
				repositoryId: connection.repositoryId,
				workspaceId: workspace.id,
			})) as { fork: string };
			const { remote } = await configureFork(
				directory,
				workspace.id,
				connection.server,
				clientName,
				access.fork,
				connection.humanToken ? configFile : undefined,
			);
			if (continuing && connection.owned) await continueFromFork(directory, remote, workspace.id);
		}
		await save();
		return { directory, workspace: attached };
	};
	let queue: Promise<unknown> = Promise.resolve();
	const execute = (raw: Partial<Command> & { tool: string }) => {
		const next = queue.then(async () => {
			configFile = defaultConfigFile;
			if (operation === "mcp" && raw.tool === "start_workspace") {
				const current = (await readFile(defaultConfigFile, "utf8")
					.then(JSON.parse)
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
						return undefined;
					})) as Connection | undefined;
				if (current?.pending?.command.tool !== "start_workspace") {
					// Allocate before locking: every start and its attachment hold their own state lock.
					configFile = join(await stateDirectory(root), `agent-${randomUUID()}.json`);
					await writeState(configFile, repositoryConnection);
					defaultConfigFile = configFile;
				}
			}
			const requested = raw.workspaceId ?? option("workspace");
			const localTools = [
				"heartbeat",
				"report_change",
				"publish_revision",
				"detach_workspace",
				"end_workspace",
				"attach_workspace",
				"preview_reconciliation",
			];
			if (requested && (localTools.includes(raw.tool) || toolByName(raw.tool)?.mutation)) {
				const current = (await readFile(defaultConfigFile, "utf8")
					.then(JSON.parse)
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
						return undefined;
					})) as Connection | undefined;
				const selected =
					(await findWorkspaceState(root, requested, repositoryConnection)) ??
					(current?.workspaceId === requested ? defaultConfigFile : undefined);
				if (selected) configFile = selected;
				else if (raw.tool === "attach_workspace") {
					configFile = join(await stateDirectory(root), `agent-${randomUUID()}.json`);
					await writeState(configFile, repositoryConnection);
				} else if (localTools.includes(raw.tool))
					throw new Error("No local execution for this workspace. Call attach_workspace with workspaceId to continue it here.");
			}
			return withStateLock(configFile, async () => {
				const fresh = (await readFile(configFile, "utf8")
					.then(JSON.parse)
					.catch((e: NodeJS.ErrnoException) => {
						if (e.code !== "ENOENT") throw e;
						return undefined;
					})) as Connection | undefined;
				for (const key of Object.keys(connection)) delete connection[key as keyof Connection];
				Object.assign(connection, fresh ?? repositoryConnection);
				// Local state selects Git work, never the caller's credential or authority.
				connection.humanToken = repositoryConnection.humanToken;
				connection.client = repositoryConnection.client;
				connection.stateFile = configFile;
				if (connection.workspaceId) tracked.add(connection.workspaceId);
				const tool = toolByName(raw.tool);
				if (!tool) throw new Error("Unknown Cruce tool");
				const command: Command = {
					namespaceId: connection.namespaceId,
					repositoryId: connection.repositoryId,
					workspaceId: connection.workspaceId,
					...raw,
					...(requested ? { workspaceId: requested } : {}),
				};
				if (raw.tool === "start_workspace") {
					if (connection.workspaceId && connection.pending?.command.tool !== "start_workspace")
						throw new Error("Detach or end the current workspace before starting another from this checkout");
					command.baseRevision ??= await git(root, ["rev-parse", "HEAD"]);
					command.title ??= option("title") ?? "Local work";
					delete command.workspaceId;
				}
				if (raw.tool === "attach_workspace") {
					if (connection.pending) throw new Error("Retry the pending mutation before changing the execution attachment");
					const id = requested ?? connection.workspaceId;
					if (!id) throw new Error("Choose workspaceId to attach an existing workspace, or start_workspace for new work");
					const workspace = (await call({
						namespaceId: connection.namespaceId,
						repositoryId: connection.repositoryId,
						tool: "get_workspace",
						workspaceId: id,
					})) as Workspace;
					connection.workspaceId = workspace.id;
					connection.baseRevision = workspace.baseRevision;
					connection.publishedRevision = workspace.publishedRevision;
					connection.integratedRevision = workspace.integratedRevision;
					connection.stateFile = configFile;
					await save();
					const { directory, workspace: attached } = await attachHere(workspace, true);
					tracked.add(workspace.id);
					return {
						...workspace,
						...attached,
						execution: connection.execution,
						directory,
						instruction: "Use this directory for workspace work; commit and push with normal Git.",
					};
				}
				const directory = connection.directory ?? root;
				if (raw.tool === "preview_reconciliation") {
					if (!connection.workspaceId || !connection.directory) throw new Error("Attach a workspace before previewing reconciliation");
					const snapshot = (await call({
						tool: "get_repository",
						namespaceId: connection.namespaceId,
						repositoryId: connection.repositoryId,
					})) as RepositorySnapshot;
					const workspace = snapshot.workspaces.find((w) => w.id === connection.workspaceId);
					if (!workspace || workspace.ownerId !== snapshot.attention?.viewerId || !snapshot.permissions.write)
						throw new Error("Preview requires your own currently authorized workspace");
					if (
						snapshot.observedCanonical &&
						(snapshot.observedCanonical.deleted || snapshot.observedCanonical.revision !== snapshot.sourceHead)
					)
						return {
							workspaceId: workspace.id,
							status: "unavailable",
							reason:
								"Observed canonical differs from accepted history. Maintainer reconciliation is required before previewing canonical.",
						};

					return { workspaceId: workspace.id, ...(await previewReconciliation(directory, snapshot.sourceHead)) };
				}

				if (["heartbeat", "report_change", "attach_workspace"].includes(raw.tool)) {
					if (!connection.execution) throw new Error("No execution is attached here; run cruce resume");
					command.execution = connection.execution;
				}
				if (raw.tool === "report_change") {
					if (!connection.baseRevision) throw new Error("Start a workspace first");
					Object.assign(command, await observeChanges(directory, connection.integratedRevision ?? connection.baseRevision));
				}
				if (raw.tool === "publish_revision") {
					if (!connection.baseRevision) throw new Error("Start a workspace first");
					command.revision ??= await git(directory, ["rev-parse", "HEAD"]);
					command.ref ??= await git(directory, ["symbolic-ref", "--short", "HEAD"]);
				}

				// A recorded deletion resumes under its own operation identity, as the console does; a new one is refused.
				let recordedKey: string | undefined;
				if (raw.tool === "cleanup_workspace" && command.workspaceId && !connection.pending) {
					const { cleanup } = (await call({
						namespaceId: connection.namespaceId,
						repositoryId: connection.repositoryId,
						tool: "get_workspace",
						workspaceId: command.workspaceId,
					})) as Workspace;
					if (cleanup && cleanup.state !== "complete") recordedKey = cleanup.command?.idempotencyKey;
				}

				const fingerprint = JSON.stringify(command);
				const retrying = !!connection.pending;
				// Presence and reports are latest-wins observations: an uncertain one is superseded by the
				// next tick rather than journaled, and never displaces another operation's pending identity.
				const observation = raw.tool === "heartbeat" || raw.tool === "report_change";
				if (observation) command.idempotencyKey = randomUUID();
				else if (tool.mutation) {
					if (connection.pending && connection.pending.command.tool !== command.tool)
						throw new Error("A previous mutation has an uncertain outcome. Retry that operation before starting another.");
					if (connection.pending) Object.assign(command, connection.pending.command);
					command.idempotencyKey = connection.pending?.command.idempotencyKey ?? recordedKey ?? randomUUID();
					connection.pending = { fingerprint, command };
					await save();
				}
				let result: Record<string, unknown>;
				try {
					result = (await call(command)) as Record<string, unknown>;
				} catch (error) {
					// Explicit authorization/validation rejection is a known outcome. Network/provider
					// failures keep the operation identity until the caller reconciles the attempt.
					if (!observation && !retrying && [400, 401, 403, 404, 405, 409, 413].includes((error as { status: number }).status)) {
						delete connection.pending;
						await save();
					}
					// Ended elsewhere, such as deleted from the console: release this checkout rather than strand its lock.
					const endedElsewhere =
						(raw.tool === "end_workspace" || raw.tool === "detach_workspace") &&
						(error as { status?: number }).status === 409 &&
						(error as Error).message.includes("Workspace has ended");
					if (!endedElsewhere) throw error;
					result = { id: connection.workspaceId, state: "ended" };
				}
				if (raw.tool === "start_workspace") {
					const workspace = result as unknown as Workspace;
					connection.workspaceId = workspace.id;
					connection.baseRevision = workspace.baseRevision;
					await save();
					const { directory } = await attachHere(workspace);
					tracked.add(workspace.id);
					delete connection.pending;
					await save();
					return {
						...result,
						directory,
						instruction: connection.owned
							? "Use this isolated directory for all workspace work."
							: "Use this attached checkout for workspace work; push to its separate Cruce remote.",
					};
				}
				if (raw.tool === "publish_revision") {
					connection.publishedRevision = String(result.revision);
					connection.integratedRevision = result.baseRevision as string | undefined;
					await save();
				}
				if (raw.tool === "end_workspace" || raw.tool === "detach_workspace") {
					const workspaceId = connection.workspaceId!;
					const cleanup = raw.tool === "end_workspace" && args.includes("--cleanup") && connection.owned;
					const retained = connection.publishedRevision ?? connection.baseRevision!;
					if (cleanup) await cleanupExecution(directory, workspaceId, retained);
					else await releaseCheckout(directory, workspaceId);
					tracked.delete(workspaceId);
					delete connection.workspaceId;
					delete connection.baseRevision;
					delete connection.publishedRevision;
					delete connection.integratedRevision;
					delete connection.execution;
					delete connection.directory;
					delete connection.owned;
					delete connection.pending;
					await save(cleanup ? undefined : directory);
				}
				if (tool.mutation && !observation && connection.pending) {
					delete connection.pending;
					await save();
				}
				return result;
			});
		});
		queue = next.catch(() => {});
		return next;
	};
	try {
		if (operation === "hint") {
			// A client prompt hook: print needed reconciliation, or nothing. Never writes local state.
			const context = coordinationContext(
				(await call({
					tool: "get_repository",
					namespaceId: connection.namespaceId,
					repositoryId: connection.repositoryId,
				})) as RepositorySnapshot,
				tracked,
			);
			if (context.available && context.summary) process.stdout.write(`Cruce: ${context.summary}\n`);
			return;
		}
		if (operation === "resume") {
			const requested = option("workspace");
			if (requested) configFile = (await findWorkspaceState(root, requested, repositoryConnection)) ?? configFile;
			await withStateLock(configFile, async () => {
				const fresh = (await readFile(configFile, "utf8")
					.then(JSON.parse)
					.catch((e: NodeJS.ErrnoException) => {
						if (e.code !== "ENOENT") throw e;
						return undefined;
					})) as Connection | undefined;
				if (fresh) {
					for (const key of Object.keys(connection)) delete connection[key as keyof Connection];
					Object.assign(connection, fresh);
				}
				connection.humanToken = repositoryConnection.humanToken;
				connection.client = repositoryConnection.client;
				connection.stateFile = configFile;
				if (connection.pending && connection.pending.command.tool !== "start_workspace")
					throw new Error("Retry the pending mutation before changing the execution attachment");
				const requested = option("workspace");
				if (requested && requested !== connection.workspaceId) {
					if (connection.workspaceId) throw new Error("Detach or end the current workspace before continuing another");
					// Continue a durable workspace here: only its pushed revisions travel, through Git.
					const workspace = (await call({
						tool: "get_workspace",
						namespaceId: connection.namespaceId,
						repositoryId: connection.repositoryId,
						workspaceId: requested,
					})) as Workspace;
					connection.workspaceId = workspace.id;
					connection.baseRevision = workspace.baseRevision;
					connection.publishedRevision = workspace.publishedRevision;
					connection.integratedRevision = workspace.integratedRevision;
					delete connection.directory;
					delete connection.execution;
					await save();
				}
				if (!connection.workspaceId) throw new Error("Choose --workspace ID to continue, or start a workspace");
				const { directory } = await attachHere({ id: connection.workspaceId, baseRevision: connection.baseRevision! }, true);
				process.stdout.write(`Workspace attached at ${directory}\n`);
				delete connection.pending;
				await save();
			});
			return;
		}
		const heartbeat = () => {
			for (const workspaceId of tracked)
				void execute({ tool: "heartbeat", workspaceId })
					.then(() => execute({ tool: "report_change", workspaceId }))
					.catch((e) => {
						// An ended workspace has nothing left to report; `cruce end` releases this checkout.
						if ((e as Error).message.includes("Workspace has ended")) tracked.delete(workspaceId);
						process.stderr.write(`${(e as Error).message}\n`);
					});
		};
		if (operation === "mcp") {
			const server = new McpServer({ name: "Cruce local bridge", version: CRUCE_VERSION }, { instructions: CRUCE_INSTRUCTIONS });
			const coordination = coordinationResource(
				server,
				`cruce://coordination/${encodeURIComponent(repositoryConnection.namespaceId)}/${encodeURIComponent(repositoryConnection.repositoryId)}`,
				async () =>
					coordinationContext(
						(await call({
							tool: "get_repository",
							namespaceId: repositoryConnection.namespaceId,
							repositoryId: repositoryConnection.repositoryId,
						})) as RepositorySnapshot,
						tracked,
					),
			);
			const detail = coordinationDetail();
			for (const prompt of CRUCE_PROMPTS)
				server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, () => ({
					messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text } }],
				}));
			for (const tool of CRUCE_TOOLS) {
				server.registerTool(
					tool.name,
					{
						description: tool.description,
						inputSchema: bridgeShape(tool),
					},
					async (values) => {
						// Workspaces behind canonical lead the response, so a coordinating agent sees them before the result.
						const current = async () => {
							const context = await coordination.refresh();
							return {
								lead: context.available && context.summary ? [{ type: "text" as const, text: `Cruce: ${context.summary}` }] : [],
								detail: { type: "text" as const, text: detail(context) },
							};
						};
						try {
							const result = await execute({ ...values, tool: tool.name });
							const { lead, detail } = await current();
							return {
								content: [...lead, { type: "text" as const, text: JSON.stringify(result) }, detail],
								structuredContent: result,
							};
						} catch (e) {
							const { lead, detail } = await current();
							return { isError: true, content: [...lead, { type: "text" as const, text: (e as Error).message }, detail] };
						}
					},
				);
			}
			const timer = setInterval(() => {
				heartbeat();
				void coordination.poll().catch((e) => process.stderr.write(`${(e as Error).message}\n`));
			}, 30000);
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
		if (operation === "watch" && args.includes("--coordination")) {
			let previous: string | undefined;
			let checking = false;
			const poll = async () => {
				if (checking) return;
				checking = true;
				try {
					let context: ReturnType<typeof coordinationContext>;
					try {
						context = coordinationContext(
							(await call({
								tool: "get_repository",
								namespaceId: repositoryConnection.namespaceId,
								repositoryId: repositoryConnection.repositoryId,
							})) as RepositorySnapshot,
						);
					} catch {
						context = { available: false, instruction: "Coordination state unavailable; recheck access before continuing work." };
					}
					const next = JSON.stringify({
						namespaceId: repositoryConnection.namespaceId,
						repositoryId: repositoryConnection.repositoryId,
						...context,
					});
					if (next !== previous) process.stdout.write(`${next}\n`);
					previous = next;
				} finally {
					checking = false;
				}
			};
			await poll();
			const timer = setInterval(() => {
				void poll();
			}, 30000);
			await new Promise<void>((done) => {
				const stop = () => {
					clearInterval(timer);
					done();
				};
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			});
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
		const tool = (
			{
				start: "start_workspace",
				publish: "publish_revision",
				preview: "preview_reconciliation",
				detach: "detach_workspace",
				end: "end_workspace",
				check: "get_repository",
			} as Record<string, string>
		)[operation];
		if (!tool) throw new Error("Unknown command; run cruce help");
		process.stdout.write(`${JSON.stringify(await execute({ tool, ...(option("title") ? { title: option("title") } : {}) }), null, 2)}\n`);
	} finally {
		await remote?.close();
	}
}
/** The bridge supplies identities and the attached execution from local state. */
function bridgeShape(tool: (typeof CRUCE_TOOLS)[number]) {
	const { namespaceId: _, repositoryId: __, idempotencyKey: ___, execution: ____, ...shape } = toolInputShape(tool);
	return shape;
}
/** Outside a Cruce checkout the bridge still starts, so the tool shows no failed server, and explains how to begin. */
async function unboundBridge(server?: string) {
	const origin = server ?? "https://CRUCE-SERVER";
	const message = `This directory is not a Cruce checkout. Clone the repository with the command in Cruce, or in an existing checkout add its canonical Git as a remote: git remote add cruce ${origin}/mcp/git/NAMESPACE/REPOSITORY/canonical.git`;
	const mcp = new McpServer({ name: "Cruce local bridge", version: CRUCE_VERSION }, { instructions: CRUCE_INSTRUCTIONS });
	for (const tool of CRUCE_TOOLS)
		mcp.registerTool(tool.name, { description: tool.description, inputSchema: bridgeShape(tool) }, async () => ({
			isError: true,
			content: [{ type: "text" as const, text: message }],
		}));
	await mcp.connect(new StdioServerTransport());
	await new Promise<void>((done) => {
		process.once("SIGTERM", done);
		process.once("SIGINT", done);
		process.stdin.once("end", done);
	});
	await mcp.close();
}
main().catch((error) => {
	process.stderr.write(`${(error as Error).message}\n`);
	// A hint never blocks or fails the prompt it decorates.
	process.exitCode = args[0] === "hint" ? 0 : 1;
});
