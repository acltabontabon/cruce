import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Credentials } from "../../runner/oauth.ts";

describe("stored OAuth credentials", () => {
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
