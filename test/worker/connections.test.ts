import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { listConnections, revokeConnection } from "../../src/worker/connections.ts";

function helpers(pages: { items: object[]; cursor?: string }[]) {
	const listUserGrants = vi.fn(async (_user: string, options?: { cursor?: string }) => pages[options?.cursor ? Number(options.cursor) : 0]);
	const lookupClient = vi.fn(async (clientId: string) => (clientId === "known" ? { clientName: "Registered client" } : null));
	const revokeGrant = vi.fn(async () => {});
	return { oauth: { listUserGrants, lookupClient, revokeGrant } as unknown as OAuthHelpers, listUserGrants, lookupClient, revokeGrant };
}

describe("agent connections", () => {
	it("lists the person's grants newest first, from recorded metadata or the registered client name", async () => {
		const h = helpers([
			{
				items: [
					{ id: "older", clientId: "known", scope: ["cruce:read"], metadata: {}, createdAt: 100 },
					{
						id: "recorded",
						clientId: "unknown",
						scope: ["cruce:read", "workspace:write"],
						metadata: { connectionId: "connection", clientName: "Codex", repositories: [{ id: "repo", label: "team/repo" }] },
						createdAt: 300,
						expiresAt: 900,
					},
				],
				cursor: "1",
			},
			{ items: [{ id: "unnamed", clientId: "missing", scope: [], metadata: null, createdAt: 200 }] },
		]);
		expect(await listConnections(h.oauth, "subject")).toEqual([
			{
				id: "recorded",
				client: "Codex",
				connectionId: "connection",
				repositories: [{ id: "repo", label: "team/repo" }],
				scopes: ["cruce:read", "workspace:write"],
				createdAt: 300_000,
				expiresAt: 900_000,
			},
			{ id: "unnamed", client: "Agent", scopes: [], createdAt: 200_000 },
			{ id: "older", client: "Registered client", scopes: ["cruce:read"], createdAt: 100_000 },
		]);
		expect(h.listUserGrants.mock.calls.map(([user]) => user)).toEqual(["subject", "subject"]);
		expect(h.lookupClient).not.toHaveBeenCalledWith("unknown");
	});
	it("revokes only under the signed-in person's own key and rejects malformed connection IDs", async () => {
		const h = helpers([]);
		await revokeConnection(h.oauth, "subject", "grant_1-a");
		expect(h.revokeGrant).toHaveBeenCalledWith("grant_1-a", "subject");
		for (const id of ["", "a:b", "../grant", "x".repeat(129)])
			await expect(revokeConnection(h.oauth, "subject", id)).rejects.toMatchObject({ status: 400 });
		expect(h.revokeGrant).toHaveBeenCalledTimes(1);
	});
});
