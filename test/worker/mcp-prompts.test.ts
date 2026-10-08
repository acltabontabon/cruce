import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { cruceServer } from "../../src/worker/mcp.ts";

it("offers fixed review-note instructions as a prompt the user runs from their own tool", async () => {
	const server = cruceServer(async () => ({}));
	const client = new Client({ name: "prompt-test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["address_review_notes"]);
		const prompt = await client.getPrompt({ name: "address_review_notes" });
		expect(prompt.messages).toHaveLength(1);
		const text = JSON.stringify(prompt.messages[0].content);
		for (const tool of ["get_review_notes", "publish_revision", "create_proposal", "reply_review_note"]) expect(text).toContain(tool);
		expect(text).toContain("A reply never resolves a note");
	} finally {
		await client.close();
	}
});
