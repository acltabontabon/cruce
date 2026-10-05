import type { Workspace } from "../shared/platform.ts";

// Presentation data only. No provider, repository, or authentication fixture is imported here.
const at = 1791158400000;
export const exampleBase = "71d94e2ab842f0c10b8d6a541e339072d1f6a8bc";
const writers: [string, string, string, string, string, string[]][] = [
	[
		"claude",
		"Claude Code",
		"Refactor authentication",
		"bc811af073d1b4972edac42eab814f3562de9980",
		"auth-refactor",
		["src/auth/session.ts", "src/auth/token.ts"],
	],
	[
		"codex",
		"Codex",
		"Update account validation",
		"994fe224f1a89335c148ede220591923b7ecde04",
		"account-validation",
		["src/auth/session.ts", "src/account/validate.ts"],
	],
	[
		"cursor",
		"Cursor",
		"Upgrade dependencies",
		"f020918d114f22085aa9e24d9c6d197fa1c30982",
		"dependency-upgrade",
		["package.json", "pnpm-lock.yaml"],
	],
];
export const exampleWorkspaces: Workspace[] = writers.map(([id, name, title, head, branch, paths], index) => ({
	id,
	repositoryId: "example-payment-api",
	actor: { id: `example-${id}`, userId: "example-developer", name, kind: "agent", connectionId: `example-connection-${id}` },
	title,
	baseRevision: exampleBase,
	headRevision: head,
	branch: `work/${branch}`,
	mode: "write",
	state: "active",
	startedAt: at + index,
	lastActivity: at,
	execution: {
		id: `local-${id}`,
		checkoutId: `checkout-${id}`,
		machineId: "example-local",
		kind: "worktree",
		owned: true,
		branch: `work/${branch}`,
	},
	fork: { id: `fork-${id}`, name: `workspace-${id}`, remote: `https://example.invalid/${id}.git`, state: "ready" },
	changes: paths.map((path) => ({ path, status: "modified" })),
	commits: [head],
}));
// Each accepted head preserves its workspace identity. Later writers incorporate accepted source before publishing.
export const exampleContributions = [
	{ id: "claude", baseRevision: exampleBase, integratedRevision: exampleBase, headRevision: exampleWorkspaces[0].headRevision },
	{
		id: "codex",
		baseRevision: exampleBase,
		integratedRevision: exampleWorkspaces[0].headRevision,
		headRevision: "b2c4e71895e0a44b7d6c983a610ef932c570d8a1",
	},
	{
		id: "cursor",
		baseRevision: exampleBase,
		integratedRevision: "b2c4e71895e0a44b7d6c983a610ef932c570d8a1",
		headRevision: "c3d8a902764ab12595f0e431ac8376bd920e7f14",
	},
] satisfies Pick<Workspace, "id" | "baseRevision" | "integratedRevision" | "headRevision">[];
