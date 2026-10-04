import { useCallback, useEffect, useRef, useState } from "react";
import type { ControllerState, TowerEvent } from "../core/controller.ts";
import type { DemoStatus, GitInfo, ServerMessage, Snapshot } from "../shared/api.ts";

export interface TowerView {
	state: ControllerState | null;
	demo: DemoStatus | null;
	git: GitInfo | null;
	liveAgents: Snapshot["liveAgents"] | null;
	connected: boolean;
	/** Events received live since connect, newest last (the state's log also carries recent history). */
	fresh: TowerEvent[];
	error: string | null;
}

/**
 * Live tower state over a WebSocket to the project's Durable Object. On every (re)connect the server
 * sends an authoritative snapshot, so a dropped connection can never leave the radar inconsistent.
 */
export function useTower(projectId: string): TowerView & { reload: () => void } {
	const [view, setView] = useState<TowerView>({
		state: null,
		demo: null,
		git: null,
		liveAgents: null,
		connected: false,
		fresh: [],
		error: null,
	});
	const socket = useRef<WebSocket | null>(null);
	const retry = useRef(0);
	const alive = useRef(true);

	const loadSnapshot = useCallback(async () => {
		try {
			const res = await fetch(`/api/projects/${projectId}`);
			const snap = (await res.json()) as Snapshot | { error: string };
			if ("error" in snap) throw new Error(snap.error);
			setView((v) => ({ ...v, state: snap.state, demo: snap.demo, git: snap.git, liveAgents: snap.liveAgents, error: null }));
		} catch (e) {
			setView((v) => ({ ...v, error: (e as Error).message }));
		}
	}, [projectId]);

	useEffect(() => {
		alive.current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		setView({ state: null, demo: null, git: null, liveAgents: null, connected: false, fresh: [], error: null });

		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const ws = new WebSocket(`${proto}://${location.host}/api/projects/${projectId}/ws`);
			socket.current = ws;
			ws.onopen = () => {
				retry.current = 0;
				setView((v) => ({ ...v, connected: true, error: null }));
				ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
			};
			ws.onmessage = (msg) => {
				if (msg.data === "pong") return;
				const data = JSON.parse(msg.data as string) as ServerMessage;
				if (data.type === "snapshot") {
					setView((v) => ({ ...v, state: data.state, demo: data.demo, git: data.git, liveAgents: data.liveAgents, connected: true }));
				} else {
					setView((v) => ({ ...v, state: data.state, demo: data.demo ?? v.demo, fresh: [...v.fresh, ...data.events].slice(-200) }));
				}
			};
			ws.onclose = () => {
				clearInterval(ping);
				setView((v) => ({ ...v, connected: false }));
				if (!alive.current) return;
				const wait = Math.min(8000, 500 * 2 ** retry.current++);
				timer = setTimeout(connect, wait);
			};
			ws.onerror = () => ws.close();
		};
		connect();
		return () => {
			alive.current = false;
			clearTimeout(timer);
			clearInterval(ping);
			socket.current?.close();
		};
	}, [projectId]);

	return { ...view, reload: loadSnapshot };
}

export async function post<T = unknown>(path: string, body: unknown, token?: string): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}
