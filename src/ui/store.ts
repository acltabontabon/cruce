import { useEffect, useState } from "react";
import type { ControllerState } from "../core/controller.ts";
import type { DemoStatus, GitInfo, Snapshot } from "../shared/api.ts";
import { connectTower, readResponse } from "./connection.ts";

export interface TowerView {
	state: ControllerState | null;
	demo: DemoStatus | null;
	git: GitInfo | null;
	integrationBlockers: Record<string, string[]>;
	connected: boolean;
	error: string | null;
}
const emptyView = (): TowerView => ({
	state: null,
	demo: null,
	git: null,
	integrationBlockers: {},
	connected: false,
	error: null,
});

export function useTower(projectId: string): TowerView {
	const [view, setView] = useState<TowerView>(emptyView);
	useEffect(() => {
		let disposed = false;
		const abort = new AbortController();
		setView(emptyView());
		const stop = connectTower(
			projectId,
			(data) => {
				if (data.state.project.id !== projectId) return;
				setView((v) =>
					data.type === "snapshot"
						? {
								state: data.state,
								demo: data.demo,
								git: data.git,
								integrationBlockers: data.integrationBlockers ?? {},
								connected: true,
								error: null,
							}
						: { ...v, state: data.state, demo: data.demo, integrationBlockers: data.integrationBlockers ?? {}, error: null },
				);
			},
			(connected) => setView((v) => ({ ...v, connected })),
			(location.protocol === "https:" ? "wss://" : "ws://") + location.host,
		);
		// HTTP establishes a useful initial/error state even when a proxy blocks WebSockets.
		fetch(`/api/demo/${encodeURIComponent(projectId)}`, { signal: abort.signal })
			.then((r) => readResponse<Snapshot>(r))
			.then((snap) => {
				if (!disposed) setView((v) => (v.state ? v : { ...v, ...snap, integrationBlockers: snap.integrationBlockers ?? {}, error: null }));
			})
			.catch((e) => {
				if (!disposed) setView((v) => ({ ...v, error: e.message }));
			});
		return () => {
			disposed = true;
			abort.abort();
			stop();
		};
	}, [projectId]);
	return view;
}
export async function post<T = unknown>(path: string, body: unknown, token?: string): Promise<T> {
	return readResponse<T>(
		await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify(body),
		}),
	);
}
