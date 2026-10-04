import { useState } from "react";
import type { Snapshot } from "../../shared/api.ts";
import { Icon } from "../components.tsx";

interface Props {
	liveAgents: Snapshot["liveAgents"] | null;
	busy: boolean;
	onLaunch(input: { title: string; description: string; priority: string }): Promise<unknown>;
}
export function launchInput(prompt: string, priority: string) {
	const description = prompt.trim();
	return { title: description.replace(/\s+/g, " ").slice(0, 120), description, priority };
}
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function Launch({ liveAgents, busy, onLaunch }: Props) {
	const [prompt, setPrompt] = useState("");
	const [priority, setPriority] = useState("normal");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const available = liveAgents?.available;
	return (
		<form
			className="launch-form"
			onSubmit={async (e) => {
				e.preventDefault();
				if (prompt.trim().length < 3 || busy || !available) return;
				setError(null);
				setSubmitting(true);
				try {
					await onLaunch(launchInput(prompt, priority));
					setPrompt("");
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setSubmitting(false);
				}
			}}
		>
			<div className="prompt-row">
				<Icon name="plus" />
				<input
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="What should an agent work on?"
					aria-label="Task prompt"
					minLength={3}
					maxLength={2000}
					required
				/>
				<button type="submit" className="btn primary" disabled={busy || !available || prompt.trim().length < 3}>
					{submitting ? "Starting…" : "Run"}
					<Icon name="arrow" size={14} />
				</button>
			</div>
			<details className="launch-options">
				<summary>Options</summary>
				<label>
					Priority
					<select value={priority} onChange={(e) => setPriority(e.target.value)}>
						{["low", "normal", "high", "critical"].map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				</label>
			</details>
			{!available && (
				<details className="connection-help">
					<summary>Connect an agent to start work</summary>
					<p>{liveAgents?.reason ?? "Checking agent availability…"}</p>
					<p>Run Claude Code from a terminal connected to this controller. This command starts the agent on your machine.</p>
					<pre>{`node runner/cruce-runner.ts --url ${shellQuote(location.origin)} --project live --title ${shellQuote(launchInput(prompt || "Your task", priority).title)} --description ${shellQuote(prompt.trim() || "Describe the task")} --priority ${priority}`}</pre>
					<p className="muted">Set CRUCE_ADMIN_TOKEN in your terminal environment. The offline demo supports scripted runs only.</p>
				</details>
			)}
			{error && (
				<p className="inline-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}
