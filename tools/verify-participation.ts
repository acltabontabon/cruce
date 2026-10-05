/**
 * Read-only auditor for the deployed multi-tool, multi-session participation proof (roadmap D2).
 * Real tools and the human reviewer act; this script only observes through its own `cruce:read`
 * OAuth connection and independently reads canonical with native Git. It never mutates state.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Credentials, login } from "../runner/oauth.ts";
import { gitRemotePath } from "../src/shared/git-access.ts";
import type { ActivityEvent, Command, RepositorySnapshot } from "../src/shared/platform.ts";
import { nativeGit } from "./verification/convergence.ts";

const root = resolve(process.env.CRUCE_VERIFY_OUTPUT_DIR ?? "dist/d2-participation");
assert.ok(root.startsWith(`${resolve("dist")}/`), "Keep verification output and credentials in the ignored dist directory");
const origin = process.env.CRUCE_PUBLIC_ORIGIN;
const namespaceId = process.env.CRUCE_VERIFY_NAMESPACE_ID;
const repositoryId = process.env.CRUCE_VERIFY_REPOSITORY_ID;
assert.ok(origin && new URL(origin).protocol === "https:", "Set an explicit HTTPS CRUCE_PUBLIC_ORIGIN");
assert.ok(namespaceId && repositoryId, "Set explicit CRUCE_VERIFY_NAMESPACE_ID and CRUCE_VERIFY_REPOSITORY_ID");
const [action = "observe", label = "checkpoint"] = process.argv.slice(2);
await mkdir(root, { recursive: true });
const credentials = new Credentials(origin, "participation-auditor");
credentials.path = resolve(root, "credentials-auditor.json");
await credentials.load();

interface Observation {
	at: string;
	label: string;
	canonical: { recorded?: string; remote?: string };
	workspaces: {
		id: string;
		title: string;
		state: string;
		ownerId: string;
		createdBy: string;
		attachedBy?: string;
		checkout?: string;
		baseRevision: string;
		headRevision: string;
		fork?: string;
		publishedRevision?: string;
		update: string;
	}[];
	overlaps: { surface: string; workspaces: string[] }[];
	artifacts: { id: string; kind: string; workspaceId: string; actor: string; actorId: string; revision: string; baseRevision?: string }[];
	proposals: {
		id: string;
		workspaceId: string;
		base: string;
		revision: string;
		state: string;
		readiness: string[];
		reviews: { actor: string; kind: string; outcome: string; revision: string }[];
	}[];
	promotions: { proposalId: string; from: string; to: string; state: string; actorKind: string }[];
	activity: Pick<ActivityEvent, "kind" | "ids" | "at">[];
	actorNames: Record<string, string>;
}
const receiptPath = resolve(root, "observations.json");
const observations: Observation[] = JSON.parse(await readFile(receiptPath, "utf8").catch(() => "[]"));
const token = () => {
	const value = credentials.tokens()?.access_token;
	assert.ok(value, "Run the auth stage first");
	return value;
};
async function call<T>(command: Partial<Command>): Promise<T> {
	const response = await fetch(`${origin}/mcp/command`, {
		method: "POST",
		headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
		body: JSON.stringify({ namespaceId, repositoryId, ...command }),
		redirect: "manual",
		signal: AbortSignal.timeout(60000),
	});
	assert.equal(response.status, 200, `Deployed ${command.tool} returned HTTP ${response.status}`);
	return (await response.json()) as T;
}

async function observe(): Promise<Observation> {
	const view = await call<RepositorySnapshot>({ tool: "get_repository" });
	const remote = `${origin}${gitRemotePath(namespaceId!, repositoryId!)}`;
	const advertised = await nativeGit(["ls-remote", remote, `refs/heads/${view.repository.defaultBranch}`], token()).catch(
		(error: Error) => `unavailable: ${error.message.split("\n")[0]}`,
	);
	const actorNames: Record<string, string> = {};
	for (const a of [
		...view.workspaces.flatMap((w) => [w.createdBy, ...(w.execution ? [w.execution.attachedBy] : [])]),
		...view.artifacts.map((a) => a.actor),
	])
		actorNames[a.id] = a.name;
	return {
		at: new Date().toISOString(),
		label,
		canonical: { recorded: view.sourceHead, remote: advertised.split(/\s/)[0] || undefined },
		workspaces: view.workspaces.map((w) => ({
			id: w.id,
			title: w.title,
			state: w.state,
			ownerId: w.ownerId,
			createdBy: w.createdBy.name,
			attachedBy: w.execution?.attachedBy.name,
			checkout: w.execution ? `${w.execution.machineId.slice(0, 8)}:${w.execution.checkoutId.slice(0, 12)}` : undefined,
			baseRevision: w.baseRevision,
			headRevision: w.headRevision,
			fork: w.fork ? `${w.fork.id}:${w.fork.state}` : undefined,
			publishedRevision: w.publishedRevision,
			update: view.workspaceUpdates[w.id]?.status ?? "unknown",
		})),
		overlaps: view.overlaps.map((o) => ({ surface: o.surface, workspaces: o.workspaces })),
		artifacts: view.artifacts.map((a) => ({
			id: a.id,
			kind: a.kind,
			workspaceId: a.workspaceId,
			actor: a.actor.name,
			actorId: a.actor.id,
			revision: a.revision,
			baseRevision: a.baseRevision,
		})),
		proposals: view.proposals.map((p) => ({
			id: p.id,
			workspaceId: p.workspaceId,
			base: p.base,
			revision: p.revision,
			state: p.state,
			readiness: view.readiness[p.id]?.reasons ?? [],
			reviews: p.reviews.map((r) => ({ actor: r.actor.name, kind: r.actor.kind, outcome: r.outcome, revision: r.revision })),
		})),
		promotions: view.promotions.map((p) => ({ proposalId: p.proposalId, from: p.from, to: p.to, state: p.state, actorKind: p.actor.kind })),
		activity: view.activity.map(({ kind, ids, at }) => ({ kind, ids, at })),
		actorNames,
	};
}

/** The D2 invariants, judged only from recorded observations and independent Git reads. */
function judge(history: Observation[]) {
	const last = history.at(-1)!;
	const results: { invariant: string; pass: boolean; detail: string }[] = [];
	const check = (invariant: string, pass: boolean, detail: string) => results.push({ invariant, pass, detail });
	const firstSeen = new Map<string, string>();
	for (const o of history) for (const w of o.workspaces) if (!firstSeen.has(w.id)) firstSeen.set(w.id, w.baseRevision);
	check(
		"baselines never change",
		history.every((o) => o.workspaces.every((w) => firstSeen.get(w.id) === w.baseRevision)),
		`${firstSeen.size} workspaces`,
	);
	const labels = new Set(Object.values(last.actorNames));
	check("at least two distinct client labels participated", labels.size >= 2, [...labels].join(", "));
	const continued = last.workspaces.find((w) => {
		const events = last.activity.filter((e) => e.ids[0] === w.id);
		const producers = new Set(last.artifacts.filter((a) => a.workspaceId === w.id && a.kind === "source").map((a) => a.actorId));
		return (
			events.filter((e) => e.kind === "execution_attached").length >= 2 &&
			events.some((e) => e.kind === "execution_detached") &&
			producers.size >= 2
		);
	});
	const checkouts = continued
		? new Set(history.flatMap((o) => o.workspaces.filter((w) => w.id === continued.id && w.checkout).map((w) => w.checkout)))
		: new Set();
	check(
		"one workspace was detached and continued from another checkout by another connection",
		!!continued && checkouts.size >= 2,
		continued ? `${continued.title}: checkouts ${[...checkouts].join(", ")}` : "none",
	);
	check(
		"canonical movement made an open proposal stale before reconciliation",
		history.some((o) => o.proposals.some((p) => p.readiness.some((r) => r.startsWith("Base revision changed")))),
		"readiness reason observed",
	);
	const complete = last.promotions.filter((p) => p.state === "complete");
	check(
		"at least two human-approved exact revisions were promoted",
		complete.length >= 2 &&
			complete.every((p) => {
				const proposal = last.proposals.find((c) => c.id === p.proposalId);
				return (
					p.actorKind === "human" &&
					proposal?.revision === p.to &&
					proposal.reviews.some((r) => r.kind === "human" && r.outcome === "approve" && r.revision === p.to)
				);
			}),
		complete.map((p) => `${p.from.slice(0, 8)}→${p.to.slice(0, 8)}`).join(", "),
	);
	check(
		"a reconciled publication pins an accepted revision as its review base",
		complete.some((p) => last.artifacts.some((a) => a.kind === "source" && a.baseRevision === p.to && a.revision !== p.to)),
		"artifact review base equals an accepted revision",
	);
	const finalTo = complete.at(-1)?.to;
	check(
		"independent Git read of canonical matches recorded accepted source",
		!!finalTo && last.canonical.recorded === finalTo && last.canonical.remote === finalTo,
		JSON.stringify(last.canonical),
	);
	check(
		"agents never approved or promoted",
		last.promotions.every((p) => p.actorKind === "human") &&
			last.proposals.every((p) => p.reviews.every((r) => r.kind === "human" || r.outcome !== "approve" || p.state !== "promoted")),
		"promotion actors are human",
	);
	return results;
}

if (action === "auth") {
	await login(origin, credentials, ["cruce:read"]);
	console.log("Auditor authorized with cruce:read only");
} else if (action === "observe") {
	const o = await observe();
	observations.push(o);
	await writeFile(receiptPath, JSON.stringify(observations, null, 2));
	console.log(
		JSON.stringify(
			{
				label: o.label,
				canonical: o.canonical,
				workspaces: o.workspaces.map(
					(w) => `${w.title} [${w.state}] by ${w.createdBy}${w.attachedBy ? ` via ${w.attachedBy}` : ""} update=${w.update}`,
				),
				overlaps: o.overlaps.map((x) => x.surface),
				proposals: o.proposals.map((p) => `${p.state} ${p.revision.slice(0, 8)} on ${p.base.slice(0, 8)} ${p.readiness.join("; ")}`),
				promotions: o.promotions.map((p) => `${p.state} ${p.from.slice(0, 8)}→${p.to.slice(0, 8)}`),
			},
			null,
			2,
		),
	);
} else if (action === "final") {
	observations.push(await observe());
	await writeFile(receiptPath, JSON.stringify(observations, null, 2));
	const results = judge(observations);
	await writeFile(resolve(root, "judgement.json"), JSON.stringify(results, null, 2));
	for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.invariant} — ${r.detail}`);
	if (results.some((r) => !r.pass)) process.exitCode = 1;
} else throw new Error("Use auth, observe LABEL or final");
