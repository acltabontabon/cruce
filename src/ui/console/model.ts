import type { CostClass, ResourceRule } from "../../core/capabilities.ts";
import type { CoordinationState, Decision, ProjectConnection } from "../../shared/coordination.ts";
import type {
	Deployment,
	DeploymentProfile,
	Environment,
	Mission,
	PlatformCommand,
	PlatformState,
	PromotionReadiness,
	Proposal,
	ResourceAccount,
	SourceRepository,
	Workspace,
} from "../../shared/platform.ts";

export interface Impact {
	cost: CostClass;
	label: string;
	outcome: ResourceRule | "allow" | "approval" | "deny";
	reason: string;
}
/** Snapshot of one native project, as rendered by the console. The controller decides; the UI only renders. */
export type View = Omit<PlatformState, "proposals" | "missions" | "replays" | "environments"> & {
	provisioned: true;
	project: ProjectConnection;
	source: SourceRepository;
	workspaces: Workspace[];
	missions: (Mission & { decision?: Decision })[];
	coordination: Omit<CoordinationState, "workstreams"> & {
		workstreams: (CoordinationState["workstreams"][number] & { decision: Decision })[];
	};
	proposals: (Proposal & { readiness: PromotionReadiness })[];
	environments: (Environment & { live?: Deployment })[];
	deploymentProfile?: DeploymentProfile;
	account?: ResourceAccount;
	resourceImpact: { local: Impact; preview: Impact; production: Impact };
	canonical: {
		revision: string;
		proposal?: { id: string; number: number; summary: string };
		mission?: string;
		agent?: string;
	};
	sourceBackend: "cloudflare_artifacts" | "offline_fixture";
	sourceHealth?: { state: string; observedHead?: string; verifiedHead?: string };
	permissions: { contribute: boolean; govern: boolean };
};
export type Unprovisioned = { provisioned: false; project: { id: string; name: string }; sourceHealth: { state: string } };
export type Execute = (cmd: Partial<PlatformCommand> & { tool: PlatformCommand["tool"] }) => Promise<unknown>;

export async function request<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, {
		credentials: "same-origin",
		...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	if (!response.ok) {
		const result = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(result.error ?? `Request failed (${response.status})`);
	}
	return response.json() as Promise<T>;
}

export type Route =
	| { view: "overview" }
	| { view: "lineage"; subject?: string }
	| { view: "environments" }
	| { view: "proposal" | "mission" | "artifact"; id: string };
export function readRoute(hash = location.hash): Route {
	const [view, id] = hash.replace(/^#\/?/, "").split("/");
	if (view === "lineage") return { view, subject: id || undefined };
	if (view === "environments") return { view };
	if ((view === "proposal" || view === "mission" || view === "artifact") && id) return { view, id: decodeURIComponent(id) };
	return { view: "overview" };
}
export const href = (route: Route) =>
	route.view === "overview"
		? "#/"
		: route.view === "lineage"
			? `#/lineage${route.subject ? `/${route.subject}` : ""}`
			: route.view === "environments"
				? "#/environments"
				: `#/${route.view}/${encodeURIComponent(route.id)}`;

export const short = (revision?: string) => (revision ? revision.slice(0, 7) : "—");
export const label = (s: string) => s.replaceAll("_", " ");
export const TRUST_LABEL: Record<string, string> = {
	reported: "Reported by agent",
	human_attested: "Human attested",
	runtime_verified: "Verified by Cruce",
	verified: "Verified",
};
export const READINESS_LABEL: Record<PromotionReadiness["outcome"], string> = {
	READY: "Ready to promote",
	VERIFY: "Needs verification",
	NEEDS_ATTENTION: "Needs attention",
	REFRESH: "Needs refresh",
	CLOSED: "Closed",
};
export function liveIn(view: View, kind: Environment["kind"]) {
	return view.environments.find((e) => e.kind === kind)?.live;
}
export function proposalFor(view: View, revision?: string) {
	return view.proposals.find((p) => p.revision === revision);
}
