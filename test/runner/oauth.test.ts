import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { auth } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { Credentials } from "../../runner/oauth.ts";

vi.mock("@modelcontextprotocol/client", async (original) => ({ ...(await original<object>()), auth: vi.fn() }));

describe("stored OAuth credentials", () => {
	it("spends a rotating refresh token once when concurrent Git pushes and the bridge all need a token", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cruce-oauth-"));
		try {
			const path = join(dir, "claude.json");
			await writeFile(
				path,
				JSON.stringify({ tokens: { access_token: "a0", refresh_token: "r0", token_type: "Bearer", expires_in: 3600 }, tokensAt: 0 }),
			);
			// A server that rotates refresh tokens and rejects a spent one, as the deployed OAuth provider does.
			let current = "r0",
				issued = 0;
			vi.mocked(auth).mockImplementation(async (provider) => {
				const spent = (await provider.tokens())?.refresh_token;
				await setTimeout(20);
				if (spent !== current) return "REDIRECT";
				current = `r${++issued}`;
				await provider.saveTokens({ access_token: `a${issued}`, refresh_token: current, token_type: "Bearer", expires_in: 3600 });
				return "AUTHORIZED";
			});
			const processes = Array.from({ length: 6 }, () => {
				const credentials = new Credentials("https://cruce.example", "claude");
				credentials.path = path;
				return credentials;
			});
			expect(await Promise.all(processes.map((c) => c.refresh()))).toEqual(Array(6).fill(true));
			expect(auth).toHaveBeenCalledTimes(1);
			expect(processes.map((c) => c.data.tokens?.access_token)).toEqual(Array(6).fill("a1"));
			// A later read reuses the current token without spending the refresh token again.
			expect((await processes[0].tokens())?.access_token).toBe("a1");
			expect(auth).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(auth).mockReset();
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("preserves independently updated fields across concurrent private state saves", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cruce-oauth-"));
		try {
			const first = new Credentials("https://cruce.example", "codex"),
				second = new Credentials("https://cruce.example", "codex");
			first.path = second.path = join(dir, "credentials.json");
			await Promise.all([
				first.saveCodeVerifier("fixture-verifier"),
				second.saveTokens({ access_token: "fixture", refresh_token: "fixture-refresh", token_type: "Bearer" }),
			]);
			const saved = JSON.parse(await readFile(first.path, "utf8"));
			expect(saved.verifier).toBe("fixture-verifier");
			expect(saved.tokens.refresh_token).toBe("fixture-refresh");
			expect((await stat(first.path)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects connection names that could escape their private state directory", () => {
		expect(() => new Credentials("https://cruce.example", "../elsewhere")).toThrow("connection name");
	});
	it("restore the registered callback so later processes refresh instead of failing as non-interactive clients", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cruce-oauth-"));
		try {
			const credentials = new Credentials("https://cruce.example", "codex");
			credentials.path = join(dir, "codex.json");
			await writeFile(
				credentials.path,
				JSON.stringify({
					client: { client_id: "client", redirect_uris: ["http://127.0.0.1:58464/callback"] },
					tokens: { access_token: "a", refresh_token: "r", token_type: "Bearer" },
				}),
			);
			expect(credentials.redirectUrl).toBeUndefined();
			await credentials.load();
			expect(credentials.redirectUrl).toBe("http://127.0.0.1:58464/callback");
			expect(credentials.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:58464/callback"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

it("uses a fresh OAuth state nonce that carries no repository", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cruce-consent-"));
	try {
		const credentials = new Credentials("https://cruce.example", "codex");
		credentials.path = join(dir, "credentials.json");
		const first = await credentials.state(),
			second = await credentials.state();
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(credentials.data.state).toBe(second);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("keeps one account-level credential file per server and tool", () => {
	const claude = new Credentials("https://cruce.example/", "claude");
	expect(claude.path).toBe(new Credentials("https://cruce.example", "claude").path);
	expect(claude.path).not.toBe(new Credentials("https://cruce.example", "git").path);
	expect(claude.path).not.toBe(new Credentials("https://other.example", "claude").path);
	expect(claude.clientMetadata.client_name).toBe("Cruce claude bridge");
});
