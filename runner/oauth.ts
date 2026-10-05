import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { Scope } from "../src/core/capabilities.ts";

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
export class Credentials implements OAuthClientProvider {
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
	constructor(server: string, connection = "agent") {
		this.clientMetadata.client_name = `Cruce ${connection} bridge`;
		this.path = join(homedir(), ".config/cruce", `${Buffer.from(new URL(server).origin).toString("base64url")}-${connection}.json`);
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
export async function login(server: string, credentials: Credentials, scopes: Scope[]) {
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
		clearTimeout(timeout);
		listener.close();
	}
}
