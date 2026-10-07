import { useEffect, useRef, useState } from "react";
import type { Command, WorkspaceUpdateDetails } from "../shared/platform.ts";
export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
export function WorkspaceUpdateInspection({ id, execute }: { id: string; execute: Execute }) {
	const [updates, setUpdates] = useState<WorkspaceUpdateDetails>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const ticket = useRef(0);
	useEffect(
		() => () => {
			ticket.current++;
		},
		[],
	);
	const load = async () => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const result = await execute({ tool: "get_workspace_updates", workspaceId: id });
			if (current === ticket.current) setUpdates(result as WorkspaceUpdateDetails);
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	return (
		<>
			<button type="button" onClick={() => void load()} disabled={loading}>
				{loading ? "Comparing with canonical…" : "See what changed on canonical"}
			</button>
			{error && <p role="alert">{error}</p>}
			{updates && (
				<div>
					<p>
						{updates.available
							? `Compared with its ${updates.basis === "baseline" ? "baseline (no publication yet)" : "latest published revision"}, the workspace is ${updates.comparison === "behind" ? "behind canonical" : updates.comparison === "diverged" ? "diverged from canonical" : updates.comparison === "ahead" ? "ahead of canonical" : updates.comparison === "current" ? "up to date" : "unrelated to canonical"}.`
							: "Canonical changes are unavailable until committed source is published."}
					</p>
					{updates.changes.length > 0 && (
						<ul>
							{updates.changes.map((f) => (
								<li key={f.path}>
									<code>{f.path}</code> · {f.status}
									{f.binary ? " · binary" : ""}
									{updates.overlappingPaths.includes(f.path) ? " · also changed in this workspace" : ""}
								</li>
							))}
						</ul>
					)}
					{updates.overlappingPaths.length > 0 && (
						<p>Merge canonical with Git, resolve any conflicts, verify, then publish a new revision.</p>
					)}
				</div>
			)}
		</>
	);
}
