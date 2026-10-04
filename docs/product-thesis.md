# Product thesis

Cruce is the logical evolution of Git collaboration for an era where agents are first-class software engineers.

**Git stays.** Revisions, history, diffs, forks, merges, conflicts and rollback are exactly what agents need: start from a known revision, work in isolation, compare before and after, merge compatible work, abandon experiments, revert failures. Cruce relies on Git instead of inventing a weaker replacement.

**The collaboration model above Git changes.** The unit of collaboration is an intent, not a pull request. An intent creates bounded missions; each mission starts from a concrete accepted revision in an isolated workspace; agents produce real commits and immutable evidence; a proposal names exact base and proposed revisions; verification targets that exact revision; human policy governs promotion; deployment is traceable back to intent.

**Cloudflare Artifacts is the canonical home.** Every project's repository, workspaces, evidence and deployment intent live in Artifacts. Cruce understands refs, commits, ancestry, trees and diffs; it never treats the repository as an opaque URL, and it never needs GitHub or GitLab.

**Agents stay where they are.** Claude Code, Codex, Cursor and future agents run on the developer's machine with local caches, Docker and familiar tools. Cruce coordinates the agent; it does not execute it. Agent vendors remain interchangeable because the interface is Cruce MCP: intentional lifecycle operations, not cloud administration.

**Autonomy is safe, not unlimited.** Agents get broad context and explicit, narrow authority. Actions that consume cloud resources carry a cost class and pass project policy and budgets; production is always a human decision. The project's Cloudflare account owns and pays for its infrastructure.

**The connection is the product.** Git knows what changed; Artifacts knows which versions exist; the agent knows what it is implementing; Workers knows what is running. Cruce connects why (intent), what work (mission), who (agent), what changed (revision), what was produced (artifacts), why we trust it (verification), where it ran (environment) and what is live (deployment) — in both directions.

The console answers: what changed, why, can I trust it, does it need me, where is it running? It stays calm and technical: no chat, no editor, no CI dashboard, no Git GUI, no vanity metrics. Technical detail is progressively disclosed.
