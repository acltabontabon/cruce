import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { coordinationContext, coordinationResource } from "../../runner/coordination.ts";
import type { AttentionItem, Workspace } from "../../src/shared/platform.ts";

const item: AttentionItem = {
	subject: "change",
	id: "proposal",
	workspaceId: "workspace",
	ownerId: "user",
	title: "Work",
	revision: "candidate",
	base: "old-base",
	group: "reconciliation",
	blockers: [{ kind: "base_stale", base: "old-base", canonical: "new-base" }],
	actions: ["reconcile_with_git"],
	mine: true,
	at: 0,
};
const context = (items: AttentionItem[] = [], sourceHead = "old-base") =>
	coordinationContext({
		sourceHead,
		attention: { asOf: 0, viewerId: "user", items, ancestryUnavailable: 0 },
	});

it("exposes only controller-authorized reconciliation with exact revision context", () => {
	const result = context([item, { ...item, id: "other", workspaceId: "other", actions: ["inspect"], mine: false }], "new-base");
	expect(result).toMatchObject({
		available: true,
		canonicalRevision: "new-base",
		reconciliation: [
			{
				workspaceId: "workspace",
				proposalId: "proposal",
				revision: "candidate",
				base: "old-base",
				blockers: item.blockers,
			},
		],
	});
	if (!result.available) throw new Error("Missing context");
	expect(result.reconciliation).toHaveLength(1);
	expect(coordinationContext({})).toMatchObject({ available: false });
});

it("notifies a subscribed client on changed state, resolution and lost authority without replaying stale data", async () => {
	const server = new McpServer({ name: "coordination-test", version: "1" });
	const client = new Client({ name: "test", version: "1" });
	let current = context();
	let denied = false;
	let reads = 0;
	const uri = "cruce://coordination/ns/repo";
	const resource = coordinationResource(server, uri, async () => {
		reads++;
		if (denied) throw new Error("Access revoked");
		return current;
	});
	const notifications: string[] = [];
	client.setNotificationHandler("notifications/resources/updated", (notification) => {
		notifications.push(notification.params.uri);
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		expect((await client.listResources()).resources).toHaveLength(1);
		await resource.poll();
		expect(reads).toBe(0);
		await client.subscribeResource({ uri });
		await resource.poll();
		expect(notifications).toEqual([]);
		current = context([item], "new-base");
		await resource.poll();
		await client.ping();
		expect(notifications).toEqual([uri]);
		const read = await client.readResource({ uri });
		expect(read.contents[0]).toMatchObject({ text: expect.stringContaining('"workspaceId":"workspace"') });
		await Promise.all([resource.poll(), resource.poll()]);
		expect(notifications).toEqual([uri]);
		current = context([], "new-base");
		await resource.poll();
		await client.ping();
		expect(notifications).toHaveLength(2);
		denied = true;
		await resource.poll();
		await client.ping();
		expect(notifications).toHaveLength(3);
		const unavailable = await client.readResource({ uri });
		expect(unavailable.contents[0]).toMatchObject({ text: expect.stringContaining('"available":false') });
		expect(JSON.stringify(unavailable)).not.toContain("candidate");
		await client.unsubscribeResource({ uri });
		const before = reads;
		await resource.poll();
		expect(reads).toBe(before);
	} finally {
		await client.close();
		await server.close();
	}
});

it("reads again after an earlier in-flight poll instead of attaching pre-mutation state to a tool result", async () => {
	const server = new McpServer({ name: "race-test", version: "1" });
	let current = context();
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const entered = new Promise<void>((done) => {
		started = done;
	});
	const gate = new Promise<void>((done) => {
		release = done;
	});
	let reads = 0;
	const resource = coordinationResource(server, "cruce://coordination/ns/repo", async () => {
		const captured = current;
		if (++reads === 1) {
			started!();
			await gate;
		}
		return captured;
	});
	const old = resource.refresh();
	await entered;
	current = context([item], "new-base");
	const afterMutation = resource.refresh();
	release!();
	expect(await old).toMatchObject({ canonicalRevision: "old-base" });
	expect(await afterMutation).toMatchObject({ canonicalRevision: "new-base", reconciliation: [{ workspaceId: "workspace" }] });
	expect(reads).toBe(2);
	await server.close();
});

it("delivers owned-workspace overlap warnings with report freshness and excludes unrelated participants", () => {
	const w = (id: string, ownerId: string, lastReportAt?: number) =>
		({ id, ownerId, headRevision: `${id}-head`, publishedRevision: `${id}-published`, lastReportAt }) as Workspace;
	const snapshot = {
		attention: { asOf: 100000, viewerId: "user", items: [], ancestryUnavailable: 0 },
		asOf: 100000,
		sourceHead: "canonical",
		workspaces: [w("mine", "user", 99999), w("other", "developer", 10000), w("quiet", "developer")],
		overlaps: [
			{ id: "shared", kind: "file" as const, surface: "api.ts", workspaces: ["mine", "other", "quiet"], evidence: "reported" as const },
			{ id: "others", kind: "file" as const, surface: "other.ts", workspaces: ["other", "quiet"], evidence: "reported" as const },
		],
		workspaceUpdates: {
			mine: { baselineRevision: "base", revision: "canonical", status: "available" as const, trust: "accepted" as const },
		},
	};
	const result = coordinationContext(snapshot);
	expect(result).toMatchObject({
		overlapCount: 1,
		overlaps: [
			{
				path: "api.ts",
				trust: "reported",
				workspaces: [
					{ workspaceId: "mine", ownerId: "user", report: "fresh" },
					{ workspaceId: "other", ownerId: "developer", report: "stale" },
					{ workspaceId: "quiet", report: "unknown" },
				],
			},
		],
		canonicalUpdates: [{ workspaceId: "mine", revision: "canonical" }],
	});
	// Fresh repeated heartbeats/reports don't create a new warning unless the projected facts change.
	expect(coordinationContext({ ...snapshot, asOf: 100010 })).toEqual(result);
});
