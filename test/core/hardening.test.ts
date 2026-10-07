import { describe, expect, it } from "vitest";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import { type Actor, type Authority, CommandInput, type Repository } from "../../src/shared/platform.ts";

const base = "a".repeat(40),
	revision = "b".repeat(40);
const human: Actor = { id: "owner", userId: "owner", name: "Owner", kind: "human" };
const repository: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "source",
	storageName: "repo-source",
	defaultBranch: "main",
	createdAt: 0,
	grants: [],
	policy: { requiredEvidence: ["tests"], protectedPaths: [], resourceRules: {} },
};
function fixture(now = 1000) {
	let id = 0;
	const state = initialRepository(repository);
	state.sourceHead = base;
	state.proposals.push({
		id: "change",
		number: 1,
		workspaceId: "work",
		artifactId: "source",
		base,
		revision,
		title: "Change",
		state: "open",
		reviews: [],
		at: 0,
	});
	state.workspaces.push({
		id: "work",
		repositoryId: "repo",
		ownerId: human.userId,
		createdBy: human,
		title: "Work",
		baseRevision: base,
		headRevision: base,
		state: "active",
		startedAt: 0,
		lastActivity: 0,
		changes: [{ path: "code.ts", status: "modified" }],
		commits: [],
		execution: {
			id: "execution",
			machineId: "machine",
			checkoutId: "checkout",
			kind: "checkout",
			owned: false,
			attachedAt: 0,
			attachedBy: human,
		},
	});
	const c = new RepositoryController(state, now, () => `id-${++id}`);
	const authority: Authority = { actor: human, namespaceId: "namespace", repositoryId: "repo", role: "owner", repositoryRole: "maintain" };
	const review = (a = authority, outcome: "approve" | "concern" = "approve") =>
		c.command(
			{
				tool: "review_proposal",
				namespaceId: "namespace",
				repositoryId: "repo",
				proposalId: "change",
				revision,
				outcome,
				reason: "Reviewed",
			},
			a,
		);
	return { c, state, authority, review };
}
describe("approval authority and effective records", () => {
	it("refuses Developer and paired-terminal approval while allowing informational agent reviews", () => {
		const f = fixture();
		expect(() => f.review({ ...f.authority, role: "developer", repositoryRole: "write" })).toThrow("Human repository maintainer required");
		expect(() => f.review({ ...f.authority, actor: { ...human, connectionId: "terminal" } })).toThrow(
			"Human repository maintainer required",
		);
		f.review({ ...f.authority, actor: { ...human, id: "agent", kind: "agent", connectionId: "oauth" } });
		expect(f.c.readiness(f.state.proposals[0]).checks.approved).toBe(false);
		f.review();
		expect(f.state.proposals[0].reviews.at(-1)?.approvalAuthority).toBe("human-maintainer");
		expect(f.c.snapshot(f.authority).permissions.approve).toBe(true);
		expect(f.c.snapshot({ ...f.authority, repositoryRole: "write" }).permissions.approve).toBe(false);
		expect(f.c.readiness(f.state.proposals[0]).checks.approved).toBe(true);
	});
	it("keeps historical unmarked approvals but requires a fresh authorized approval", () => {
		const f = fixture();
		f.state.proposals[0].reviews.push({ id: "old", actor: human, revision, outcome: "approve", reason: "Previously reviewed", at: 0 });
		expect(f.c.readiness(f.state.proposals[0]).checks.approved).toBe(false);
		f.review();
		expect(f.state.proposals[0].reviews).toHaveLength(2);
		expect(f.c.readiness(f.state.proposals[0]).checks.reviewIds).toEqual(["id-1"]);
		expect(CommandInput.safeParse({ tool: "review_proposal", approvalAuthority: "human-maintainer" }).success).toBe(false);
	});
	it("uses the latest review and evidence from each participant", () => {
		const f = fixture();
		f.review();
		f.review(f.authority, "concern");
		expect(f.c.readiness(f.state.proposals[0]).checks).toMatchObject({ approved: false, concerns: 1, reviewIds: ["id-2"] });
		for (const outcome of ["fail", "pass"] as const)
			f.c.command(
				{
					tool: "record_verification",
					namespaceId: "namespace",
					repositoryId: "repo",
					proposalId: "change",
					revision,
					kind: "tests",
					outcome,
					reason: "Checked again",
					humanAttested: true,
				},
				f.authority,
			);
		expect(f.c.readiness(f.state.proposals[0]).checks.evidence[0]).toMatchObject({
			trusted: true,
			failed: false,
			verificationIds: ["id-4"],
		});
	});
});
describe("report freshness", () => {
	it("keeps report time unknown until a report and never refreshes it with a heartbeat", () => {
		const f = fixture(60000);
		const { attachedAt: _, attachedBy: __, ...execution } = f.state.workspaces[0].execution!;
		f.state.workspaces.push({ ...structuredClone(f.state.workspaces[0]), id: "other", lastReportAt: 0 });
		const command = { namespaceId: "namespace", repositoryId: "repo", workspaceId: "work", execution };
		f.c.command({ ...command, tool: "heartbeat" }, f.authority);
		expect(f.c.overlaps()[0].observedAt).toBeUndefined();
		f.c.command({ ...command, tool: "report_change", revision, changes: [{ path: "code.ts", status: "modified" }] }, f.authority);
		expect(f.state.workspaces[0].lastReportAt).toBe(60000);
		new RepositoryController(f.state, 80000, () => "later").command({ ...command, tool: "heartbeat" }, f.authority);
		expect(f.state.workspaces[0].lastReportAt).toBe(60000);
		expect(f.c.overlaps()[0].observedAt).toBe(0);
		expect(f.state.workspaces[0].execution).toBeDefined();
	});
});
