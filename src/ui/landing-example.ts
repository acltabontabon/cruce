// Presentation data only. No provider, repository, or authentication fixture is imported here.
// The story: three workspaces start from one canonical baseline, then reach canonical one promotion at a time.
export const rev = (revision: string) => revision.slice(0, 7);

export const exampleRepository = "fernloop / payments";
export const exampleBaseline = "c3d8a902764ab12595f0e431ac8376bd920e7f14";

export type ExampleWorkspace = {
	id: "auth" | "billing" | "deps";
	tool: string;
	/** Reported heads as local work advances. */
	heads: string[];
};

export const exampleWorkspaces: ExampleWorkspace[] = [
	{ id: "auth", tool: "Claude Code", heads: ["a42f91c0e5d7b3196f80c2ad4b7e1593c06d8a2e"] },
	{
		id: "billing",
		tool: "Codex",
		// The second head is the explicit reconciliation: billing merges accepted canonical a42f91c, verifies and pushes.
		heads: ["96cd0e34b81f27a5d903c6e14f8ba7d2105c93e6", "7be2d14a9c03f6e85b1d47a2e930c5f8d61b0a47"],
	},
	{ id: "deps", tool: "Cursor", heads: ["f881b27d34c9e0a6152f8b3dc7e049a1b65d2f90", "0d93e5ab7f2148c6e9a30d5b81f7c264ea9b13d5"] },
];

export const [auth, billing, deps] = exampleWorkspaces;
/** Canonical revisions in promotion order. A promotion moves canonical to exactly the approved revision. */
export const examplePromotions = [auth.heads[0], billing.heads[1]];
export const sharedPath = "src/auth/session.ts";
