import { useState } from "react";
import { AgentConnections } from "./connections.tsx";
import { CopyCommand, PageHeader } from "./design.tsx";

const TOOLS = [
	["claude", "Claude Code", "claude"],
	["codex", "Codex", "codex"],
	["cursor", "Cursor", "cursor-agent"],
] as const;
export const START_PROMPT =
	"Use the Cruce tools to start a workspace for this task and work only in the directory it returns. Commit and push, then publish the revision, record your test results and propose it for review.";

/** One-time setup for this person's machine, then the tool connections they approved. Nothing here names a repository. */
export function LocalSetup() {
	const [tool, setTool] = useState<(typeof TOOLS)[number][0]>("claude");
	const origin = location.origin,
		[, name, launch] = TOOLS.find(([id]) => id === tool)!;
	return (
		<>
			<PageHeader kicker="Your account" title="Local setup" />
			<p className="page-lead">Set up once per machine. Every repository you can access works afterwards, including new ones.</p>
			<ol className="steps local-setup">
				<li>
					<h3>Install the client</h3>
					<p className="muted">Use Git and Node.js 22.18 or later.</p>
					<CopyCommand text={`npm install --global ${origin}/downloads/cruce-client.tgz`} />
				</li>
				<li>
					<h3>Authorize Git</h3>
					<CopyCommand text={`cruce login --server ${origin}`} />
					<p className="muted">Approve in your browser. Git can then clone and fetch every repository you can access.</p>
				</li>
				<li>
					<h3>Connect your tool</h3>
					<fieldset className="segmented">
						<legend className="sr-only">Agent tool</legend>
						{TOOLS.map(([id, label]) => (
							<button key={id} type="button" aria-pressed={tool === id} onClick={() => setTool(id)}>
								{label}
							</button>
						))}
					</fieldset>
					<CopyCommand text={`cruce connect --server ${origin} --client ${tool}`} />
					<p className="muted">
						Approve in your browser, then restart {name}. This adds Cruce to {name}'s own settings; your repositories are not changed.
					</p>
				</li>
				<li>
					<h3>Start work</h3>
					<p>
						Open a repository and use <strong>Clone</strong> next to its canonical revision. Run <code>{launch}</code> in the clone, then
						ask it:
					</p>
					<CopyCommand text={START_PROMPT} />
				</li>
			</ol>
			<p className="cost">
				Authorizing and connecting use no cloud resources. Starting a workspace creates an isolated fork and uses namespace resource
				operations.
			</p>
			<AgentConnections />
		</>
	);
}
