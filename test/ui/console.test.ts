import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialPlatform, PlatformController } from "../../src/core/platform.ts";
import { type Actor, PlatformCommandInput, type Proposal } from "../../src/shared/platform.ts";
import { Environments } from "../../src/ui/console/Environments.tsx";
import type { View } from "../../src/ui/console/model.ts";
import { Overview } from "../../src/ui/console/Overview.tsx";
import { ProposalView } from "../../src/ui/console/ProposalView.tsx";
import { ArtifactView, MissionView } from "../../src/ui/console/Records.tsx";

const BASE = "a".repeat(40),
	HEAD = "b".repeat(40);
const human: Actor = { developerId: "owner", tenantId: "t", projectIds: ["p"], kind: "human", maintainer: true, canWrite: true },
	agent: Actor = { ...human, kind: "agent" };
let n = 0;
const command = (tool: typeof PlatformCommandInput._output.tool, extra: Record<string, unknown> = {}) =>
	PlatformCommandInput.parse({ tool, projectId: "p", idempotencyKey: `k${++n}`, ...extra });

function fixture(): View {
	const c = new PlatformController(initialPlatform(), 1_700_000_000_000);
	const i = c.execute(
		command("create_intent", { title: "Add rate limiting", context: "Burst traffic", why: "Protect Customer API" }),
		human,
		BASE,
	) as { id: string };
	const m = c.execute(
		command("create_mission", {
			intentId: i.id,
			plan: {
				summary: "Implement and verify rate limiting",
				intent: "Limit bursts",
				writeSet: [{ type: "file", resource: "src/limit.ts" }],
			},
		}),
		human,
		BASE,
	) as { id: string };
	const mission = c.mission(m.id);
	Object.assign(mission, {
		state: "active",
		baseRevision: BASE,
		headRevision: HEAD,
		workstreamId: "W-1",
		agent: { developerId: "owner", tool: "claude", instance: "1", sessionId: "S" },
	});
	const a = c.artifact({
		kind: "source",
		missionId: m.id,
		intentId: i.id,
		title: "Rate limiting",
		summary: "Token bucket",
		revision: HEAD,
		parentRevision: BASE,
		contentHash: HEAD,
		storage: { repository: "project-1--w-1", revision: HEAD },
		producer: { actor: "owner", kind: "agent", tool: "claude" },
		execution: { location: "local", detail: "claude" },
		related: [],
		trust: "verified",
		source: { base: BASE, commits: [{ oid: HEAD, message: "Add token bucket" }], files: 12 },
	});
	c.artifact({ ...a, kind: "test_report", title: "npm test", trust: "reported" });
	const p = c.execute(command("create_proposal", { missionId: m.id, artifactId: a.id }), agent, BASE) as Proposal;
	c.gate("preview.deploy", { ...agent }, { proposalId: p.id, missionId: m.id, revision: HEAD });
	c.state.policy.resources.rules["preview.deploy"] = "approval";
	c.gate("preview.deploy", { ...agent }, { proposalId: p.id, missionId: m.id, revision: BASE });
	const env = c.addEnvironment(
		{
			name: "Production",
			kind: "production",
			target: { type: "cloudflare_worker", workerName: "customer-api", accountId: "0".repeat(32), deployRepository: "project-1--deploy" },
			smokeChecks: [{ path: "/", expectStatus: 200 }],
			createdBy: "owner",
		},
		human,
	);
	const d = c.recordDeployment({ environmentId: env.id, revision: BASE, actor: "owner" }, human);
	c.updateDeployment(d.id, { state: "deployed", url: "https://customer-api.workers.dev" });
	const impact = { cost: "metered" as const, label: "Metered Cloudflare operation", outcome: "allow" as const, reason: "Allowed" };
	return {
		...c.everything(),
		provisioned: true,
		usage: {},
		project: {
			id: "p",
			tenantId: "t",
			artifactRepository: "project-1",
			name: "Customer API",
			active: true,
			version: 1,
			capabilities: [],
			policy: { mode: "enforced", semantic: "off" },
		},
		source: {
			backend: "cloudflare_artifacts",
			namespace: "cruce",
			name: "project-1",
			defaultBranch: "main",
			acceptedRef: "refs/heads/main",
			canonicalRevision: BASE,
		},
		workspaces: [
			{
				id: "W-1",
				missionId: m.id,
				repository: "project-1--w-1",
				remote: "https://artifacts.test/project-1--w-1",
				baseRevision: BASE,
				headRevision: HEAD,
				state: "published",
			},
		],
		missions: c.state.missions,
		coordination: { workstreams: [] } as never,
		proposals: c.state.proposals.map((x) => ({ ...x, readiness: c.readiness(x.id, BASE) })),
		environments: c.state.environments.map((e) => ({
			...e,
			live: c.state.deployments.find((x) => x.environmentId === e.id && x.state === "deployed"),
		})),
		deploymentProfile: { kind: "cloudflare_worker", configPath: "wrangler.jsonc", workerName: "customer-api", revision: BASE },
		account: {
			mode: "operator",
			accountId: "0".repeat(32),
			label: "Cruce deployment account",
			credential: "stored",
			capabilities: ["artifacts", "builds"],
		},
		resourceImpact: {
			local: { ...impact, cost: "local", label: "Local execution; no cloud compute" },
			preview: impact,
			production: { ...impact, cost: "metered_production", outcome: "approval" },
		},
		canonical: { revision: BASE },
		sourceBackend: "cloudflare_artifacts",
		sourceHealth: { state: "verified" },
		permissions: { contribute: true, govern: true },
	} as View;
}
const execute = async () => ({});

describe("native console", () => {
	it("summarizes production, accepted source, Artifacts and what needs a human", () => {
		const html = renderToStaticMarkup(createElement(Overview, { view: fixture(), execute }));
		expect(html).toContain("Customer API");
		expect(html).toContain("Cloudflare Artifacts");
		expect(html).toContain("customer-api.workers.dev");
		expect(html).toContain("Build and deploy a Worker preview");
		expect(html).toContain("#1 Token bucket");
		expect(html).toContain("Cloudflare Worker detected");
		expect(html).not.toMatch(/Pull request|branch/i);
	});
	it("connects a proposal to exact revisions, evidence trust, resource impact and the human decision", () => {
		const view = fixture();
		const html = renderToStaticMarkup(createElement(ProposalView, { view, id: view.proposals[0].id, execute }));
		expect(html).toContain("Proposal #1");
		expect(html).toContain("bbbbbbb");
		expect(html).toContain("aaaaaaa");
		expect(html).toContain("12 files · 1 commits");
		expect(html).toContain("required; trusted evidence missing");
		expect(html).toContain("Human approval required");
		for (const action of ["Reject", "Request changes", "Promote", "Promote and deploy to production"])
			expect(html).toContain(`>${action}</button>`);
	});
	it("shows mission workspaces and artifacts without raw records by default", () => {
		const view = fixture();
		const mission = renderToStaticMarkup(createElement(MissionView, { view, id: view.missions[0].id }));
		expect(mission).toContain("project-1--w-1");
		expect(mission).toContain("claude");
		const artifact = renderToStaticMarkup(createElement(ArtifactView, { view, id: view.artifacts[1].id, execute }));
		expect(artifact).toContain("Reported by agent");
		expect(artifact).toContain("local");
	});
	it("makes the resource boundary and policy explicit without exposing credentials", () => {
		const html = renderToStaticMarkup(createElement(Environments, { view: fixture(), execute, reload: async () => {} }));
		expect(html).toContain("stored (sealed, never shown)");
		expect(html).toContain("Metered Cloudflare operation with production impact");
		expect(html).toContain("Worker customer-api from project-1--deploy");
	});
});
