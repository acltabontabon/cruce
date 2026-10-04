import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../src/shared/api.ts";
import { connectTower, readResponse } from "../../src/ui/connection.ts";

class FakeSocket {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn<(data: string) => void>();
	close = vi.fn(() => {
		this.readyState = 3;
	});
	constructor(readonly url: string) {}
	open() {
		this.readyState = 1;
		this.onopen?.({} as Event);
	}
	message(data: string) {
		this.onmessage?.({ data } as MessageEvent);
	}
	closed() {
		this.readyState = 3;
		this.onclose?.({} as CloseEvent);
	}
}

function sockets() {
	const all: FakeSocket[] = [];
	return {
		all,
		make: (url: string) => {
			const socket = new FakeSocket(url);
			all.push(socket);
			return socket as unknown as WebSocket;
		},
	};
}

describe("project connections", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not revive an old project or deliver its late events after switching", () => {
		const factory = sockets();
		const oldReceive = vi.fn<(message: ServerMessage) => void>();
		const oldConnection = vi.fn<(connected: boolean) => void>();
		const stopOld = connectTower("demo", oldReceive, oldConnection, "ws://localhost", factory.make);
		const old = factory.all[0];
		old.open();
		stopOld();
		const currentReceive = vi.fn<(message: ServerMessage) => void>();
		const currentConnection = vi.fn<(connected: boolean) => void>();
		const stopCurrent = connectTower("live", currentReceive, currentConnection, "ws://localhost", factory.make);
		const current = factory.all[1];
		current.open();
		old.message('{"type":"update","project":"demo"}');
		old.closed();
		old.open();
		vi.advanceTimersByTime(30_000);
		expect(factory.all).toHaveLength(2);
		expect(oldReceive).not.toHaveBeenCalled();
		expect(oldConnection.mock.calls).toEqual([[true]]);
		expect(old.send).not.toHaveBeenCalled();
		expect(current.send).toHaveBeenCalledWith("ping");
		current.message('{"type":"update","project":"live"}');
		expect(currentReceive).toHaveBeenCalledTimes(1);
		expect(current.url).toBe("ws://localhost/api/demo/live/ws");
		stopCurrent();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reconnects after a drop but ignores events from the replaced socket", () => {
		const factory = sockets();
		const receive = vi.fn();
		const connection = vi.fn();
		const stop = connectTower("demo", receive, connection, "ws://localhost", factory.make);
		const old = factory.all[0];
		old.open();
		old.closed();
		vi.advanceTimersByTime(500);
		expect(factory.all).toHaveLength(2);
		factory.all[1].open();
		old.message('{"type":"update"}');
		old.closed();
		vi.advanceTimersByTime(8_000);
		expect(factory.all).toHaveLength(2);
		expect(receive).not.toHaveBeenCalled();
		expect(connection.mock.calls).toEqual([[true], [false], [true]]);
		stop();
	});

	it("cancels a pending reconnect when its project closes", () => {
		const factory = sockets();
		const stop = connectTower("demo", vi.fn(), vi.fn(), "ws://localhost", factory.make);
		factory.all[0].closed();
		stop();
		vi.advanceTimersByTime(10_000);
		expect(factory.all).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles pong quietly and closes malformed-message sockets", () => {
		const factory = sockets();
		const receive = vi.fn();
		const stop = connectTower("demo", receive, vi.fn(), "ws://localhost", factory.make);
		factory.all[0].open();
		factory.all[0].message("pong");
		expect(receive).not.toHaveBeenCalled();
		factory.all[0].message("invalid JSON");
		expect(factory.all[0].close).toHaveBeenCalledOnce();
		stop();
	});
});

describe("command responses", () => {
	it.each([
		[{ ok: false, reason: "Nothing to reroute" }, "Nothing to reroute"],
		[{ landed: false, reason: "Waiting for validation" }, "Waiting for validation"],
		[{ error: "Controller unavailable" }, "Controller unavailable"],
	])("rejects semantic failure despite HTTP 200: %j", async (body, message) => {
		await expect(readResponse(Response.json(body))).rejects.toThrow(message as string);
	});

	it("preserves an HTTP error's server reason", async () => {
		await expect(readResponse(Response.json({ error: "Invalid controller token" }, { status: 401 }))).rejects.toThrow(
			"Invalid controller token",
		);
	});

	it("returns the real response for successful commands", async () => {
		await expect(readResponse(Response.json({ landed: true, commit: "abc123" }))).resolves.toEqual({ landed: true, commit: "abc123" });
	});
});
