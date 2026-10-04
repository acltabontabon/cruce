import { useState } from "react";
import type { Snapshot } from "../../shared/api.ts";

interface Props {
	liveAgents: Snapshot["liveAgents"] | null;
	busy: boolean;
	onLaunch(input: { title: string; description: string; priority: string }): void;
}

/** Delegate a Mission to a real coding agent (live project). */
export function Launch({ liveAgents, busy, onLaunch }: Props) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState("normal");
	if (!open) {
		return (
			<button type="button" className="btn launch-btn" onClick={() => setOpen(true)}>
				+ Delegate a Mission
			</button>
		);
	}
	const available = liveAgents?.available;
	return (
		<form
			className="launch"
			onSubmit={(e) => {
				e.preventDefault();
				if (!title.trim()) return;
				onLaunch({ title: title.trim(), description: description.trim() || title.trim(), priority });
				setTitle("");
				setDescription("");
				setOpen(false);
			}}
		>
			<div className="eyebrow">New Mission</div>
			<input
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Implement refresh-token rotation"
				aria-label="Mission title"
			/>
			<textarea
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				placeholder="What should the agent achieve?"
				rows={3}
				aria-label="Description"
			/>
			<select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
				{["low", "normal", "high", "critical"].map((p) => (
					<option key={p} value={p}>
						{p}
					</option>
				))}
			</select>
			{available ? (
				<div className="launch-row">
					<button type="submit" className="btn primary" disabled={busy || !title.trim()}>
						Launch in Sandbox
					</button>
					<button type="button" className="btn ghost" onClick={() => setOpen(false)}>
						Cancel
					</button>
				</div>
			) : (
				<div className="launch-note">
					<div>Sandbox agents unavailable here: {liveAgents?.reason ?? "unknown"}.</div>
					<div>Fly Claude Code from your machine instead:</div>
					<pre>{`CRUCE_ADMIN_TOKEN=… node runner/cruce-runner.ts \\\n  --url ${location.origin} --project live \\\n  --title "${title || "…"}" --priority ${priority}`}</pre>
					<button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
						Close
					</button>
				</div>
			)}
		</form>
	);
}
