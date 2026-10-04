import type { ServerMessage } from "../shared/api.ts";

/** A connection owns its callbacks and timers; a closed project can never resurrect itself. */
export function connectTower(
	projectId: string,
	receive: (message: ServerMessage) => void,
	connection: (connected: boolean) => void,
	url: string,
	makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
) {
	let disposed = false;
	let current: WebSocket | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	let attempt = 0;
	const connect = () => {
		if (disposed) return;
		const ws = makeSocket(`${url}/api/demo/${encodeURIComponent(projectId)}/ws`);
		current = ws;
		const owns = () => !disposed && current === ws;
		ws.onopen = () => {
			if (!owns()) return;
			attempt = 0;
			connection(true);
			ping = setInterval(() => {
				if (owns() && ws.readyState === 1) ws.send("ping");
			}, 25_000);
		};
		ws.onmessage = (event) => {
			if (!owns() || event.data === "pong") return;
			try {
				receive(JSON.parse(event.data as string) as ServerMessage);
			} catch {
				ws.close();
			}
		};
		ws.onclose = () => {
			if (!owns()) return;
			clearInterval(ping);
			connection(false);
			retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempt++));
		};
		ws.onerror = () => {
			if (owns()) ws.close();
		};
	};
	connect();
	return () => {
		disposed = true;
		clearInterval(ping);
		clearTimeout(retry);
		current?.close();
	};
}

export async function readResponse<T>(response: Response): Promise<T> {
	const data = (await response.json()) as T & { error?: string; reason?: string; ok?: boolean; landed?: boolean };
	if (!response.ok || data.ok === false || data.landed === false || data.error)
		throw new Error(data.error ?? data.reason ?? `Request failed (HTTP ${response.status})`);
	return data;
}
