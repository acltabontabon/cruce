import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSubscriptions } from "../../src/worker/event-subscriptions.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Flight subscription cleanup", () => {
	it("finds and removes all matching subscriptions beyond the first page", async () => {
		const subs = new EventSubscriptions({ accountId: "test", queueId: "queue", apiToken: "test-only", namespace: "cruce" });
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			if (init.method === "DELETE") return Response.json({ success: true, result: {} });
			const page = Number(new URL(_url).searchParams.get("page"));
			return Response.json({
				success: true,
				result:
					page === 1
						? [{ id: "unrelated", name: "canonical" }]
						: [
								{ id: "one", name: subs.nameFor("auth-service--f001") },
								{ id: "two", name: subs.nameFor("auth-service--f001") },
							],
				result_info: { total_pages: 2 },
			});
		});
		vi.stubGlobal("fetch", fetch);
		await subs.unsubscribeRepo("auth-service--f001");
		expect(fetch.mock.calls.filter(([, init]) => init.method === "DELETE").map(([url]) => url.split("/").at(-1))).toEqual(["one", "two"]);
	});

	it("keeps cleanup pending when subscription deletion fails", async () => {
		const subs = new EventSubscriptions({ accountId: "test", queueId: "queue", apiToken: "test-only", namespace: "cruce" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) =>
				init.method === "DELETE"
					? Response.json({ success: false, errors: [{ message: "unavailable" }] }, { status: 503 })
					: Response.json({ success: true, result: [{ id: "one", name: subs.nameFor("auth-service--f001") }] }),
			),
		);
		await expect(subs.unsubscribeRepo("auth-service--f001")).rejects.toThrow("unavailable");
	});
});
