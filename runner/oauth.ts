import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { Scope } from "../src/core/capabilities.ts";
import { type RepositoryConsentTarget, repositoryConsentState } from "../src/shared/repository-consent.ts";
import { withStateLock, writeState } from "./state-file.ts";

async function read<T>(path: string, fallback: T) {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return fallback;
	}
}
async function merge(path: string, value: Partial<Credentials["data"]>): Promise<Credentials["data"]> {
	const merged = { ...(await read<Credentials["data"]>(path, {})), ...value };
	await writeState(path, merged);
	return merged;
}
/** Refresh this long before expiry, so a token handed to Git or the bridge outlives the request that carries it. */
const EXPIRY_MARGIN_MS = 120_000;
export class Credentials implements OAuthClientProvider {
	redirectUrl: string | undefined;
	clientMetadata = {
		client_name: "Cruce local coordination bridge",
		redirect_uris: [] as string[],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none" as const,
	};
	data: {
		client?: StoredOAuthClientInformation;
		tokens?: StoredOAuthTokens;
		/** When the stored tokens were issued, so every process sharing this file agrees whether they are current. */
		tokensAt?: number;
		verifier?: string;
		state?: string;
	} = {};
	path: string;
	consentTarget?: RepositoryConsentTarget;
	server: string;
	/** This process holds the file lock, so saves write directly. */
	private locked = false;
	/** This process is driving an authorization, so the SDK reads exactly what is stored. */
	authorizing = false;
	constructor(server: string, connection = "agent", target?: RepositoryConsentTarget) {
		this.server = server;
		if (!/^[a-zA-Z0-9-]{1,160}$/.test(connection)) throw new Error("Use a connection name containing only letters, numbers and dashes");
		if (target) repositoryConsentState(target, "validation");
		this.consentTarget = target;
		this.clientMetadata.client_name = `Cruce ${connection} bridge`;
		this.path = join(
			homedir(),
			".config/cruce",
			`${Buffer.from(new URL(server).origin).toString("base64url")}-${connection}${
				target
					? `-${createHash("sha256")
							.update(JSON.stringify([target.namespaceId, target.repositoryId]))
							.digest("hex")}`
					: ""
			}.json`,
		);
	}
	async load() {
		this.data = await read(this.path, {});
		// The SDK treats a provider without a redirect URL as a non-interactive client and never
		// refreshes. Restore the registered callback so later processes (bridge, Git helper) refresh.
		const registered = (this.data.client as { redirect_uris?: string[] } | undefined)?.redirect_uris?.[0];
		if (registered && !this.redirectUrl) {
			this.redirectUrl = String(registered);
			this.clientMetadata.redirect_uris = [this.redirectUrl];
		}
	}
	clientInformation() {
		return this.data.client;
	}
	private save(value: Partial<Credentials["data"]>) {
		return this.locked ? merge(this.path, value) : withStateLock(this.path, () => merge(this.path, value));
	}
	async saveClientInformation(client: StoredOAuthClientInformation) {
		this.data = await this.save({ client });
	}
	/** The bridge transport reads tokens before every request; outside an authorization it gets current ones. */
	async tokens() {
		if (!this.authorizing) await this.refresh();
		return this.data.tokens;
	}
	async saveTokens(tokens: StoredOAuthTokens) {
		this.data = await this.save({ tokens, tokensAt: Date.now() });
	}
	current() {
		const { tokens, tokensAt } = this.data;
		if (!tokens?.access_token || tokensAt === undefined || tokens.expires_in === undefined) return false;
		return Date.now() < tokensAt + tokens.expires_in * 1000 - EXPIRY_MARGIN_MS;
	}
	/**
	 * The server rotates refresh tokens and rejects a spent one, and the bridge and every Git helper for this connection
	 * share this file. Refresh only under the file lock and after re-reading it, so exactly one process spends each
	 * refresh token and the others reuse what it stored. Returns whether current tokens are stored.
	 */
	async refresh() {
		await this.load();
		if (this.current()) return true;
		if (!this.data.tokens?.refresh_token) return false;
		return withStateLock(this.path, async () => {
			this.locked = this.authorizing = true;
			try {
				await this.load();
				if (this.current()) return true;
				return (await auth(this, { serverUrl: `${this.server}/mcp` })) === "AUTHORIZED";
			} finally {
				this.locked = this.authorizing = false;
			}
		});
	}
	async saveCodeVerifier(verifier: string) {
		this.data = await this.save({ verifier });
	}
	codeVerifier() {
		if (!this.data.verifier) throw new Error("No pending authorization");
		return this.data.verifier;
	}
	async state() {
		const nonce = randomUUID();
		const state = this.consentTarget ? repositoryConsentState(this.consentTarget, nonce) : nonce;
		this.data = await this.save({ state });
		return state;
	}
	redirectToAuthorization(url: URL) {
		process.stderr.write(`Open this sign-in link in your browser:\n${url.href}\n`);
	}
}
export async function login(server: string, credentials: Credentials, scopes: Scope[], target?: RepositoryConsentTarget) {
	credentials.consentTarget = target;
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
	credentials.authorizing = true;
	try {
		const result = await auth(credentials, {
			serverUrl: `${server}/mcp`,
			scope: [...scopes, "offline_access"].join(" "),
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
		credentials.authorizing = false;
		clearTimeout(timeout);
		listener.close();
	}
}
