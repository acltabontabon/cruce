import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Credentials } from "../../runner/oauth.ts";

describe("stored OAuth credentials", () => {
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
