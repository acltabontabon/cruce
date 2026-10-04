import { resourceLabel } from "../core/airspace.ts";
import { clearanceBrief } from "../core/controller.ts";
import type { ProtocolRequest } from "../shared/api.ts";
import { flightRef } from "./project-git.ts";
import type { Tower } from "./tower.ts";

/**
 * The Cruce agent protocol. Any coding agent (Claude Code in a Sandbox, an external runner, a future
 * MCP client) coordinates through these operations; nothing here is specific to one provider.
 *
 *   status · plan · amend · request · activity · heartbeat · publish · validate · land · fail
 */
export async function handleProtocol(tower: Tower, flightId: string, req: ProtocolRequest): Promise<unknown> {
	const f = tower.flight(flightId);
	if (!["status", "fail"].includes(req.op)) tower.assertActive(flightId);
	switch (req.op) {
		case "status":
			return status(tower, flightId);
		case "plan":
		case "amend": {
			const { plan, clearance } = tower.mutate((c) => c.submitPlan(flightId, req.plan, req.op === "amend" ? req.reason : undefined));
			return { planVersion: plan.planVersion, clearance: clearance.status, brief: clearanceBrief(tower.state, flightId) };
		}
		case "request": {
			const { plan, clearance } = tower.mutate((c) => c.requestAirspace(flightId, req.resources, req.reason));
			return {
				planVersion: plan.planVersion,
				clearance: clearance.status,
				granted: clearance.cleared.map((r) => resourceLabel(r, tower.state.index)),
				held: clearance.held.map((h) => ({ resource: resourceLabel(h.resource, tower.state.index), reason: h.reason })),
				brief: clearanceBrief(tower.state, flightId),
			};
		}
		case "activity":
			tower.mutate((c) => c.reportActivity(flightId, req.text));
			return { ok: true };
		case "heartbeat":
			tower.mutate((c) => c.heartbeat(flightId));
			return { ok: true, clearance: tower.state.traffic.clearances[flightId]?.status ?? "none" };
		case "ack-instruction":
			return { ok: true, instruction: tower.mutate((c) => c.ackInstruction(flightId, req.instructionId)) };
		case "publish": {
			const out = await tower.publish(flightId, {
				parent: req.parent,
				files: req.files,
				message: req.message,
				author: req.author,
				claimedCommit: req.claimedCommit,
			});
			return {
				approved: out.approved,
				commit: out.commit,
				matchesClaim: out.matchesClaim,
				summary: out.gate.summary,
				outside: out.gate.outside.map((o) => ({ path: o.path, resource: resourceLabel(o.resource, tower.state.index), reason: o.reason })),
				next: out.approved
					? "validate, then request landing"
					: "file a Flight Plan amendment (op: request) or revert the changes outside clearance",
			};
		}
		case "validate":
			tower.validate(flightId, req.commit, req.passed, req.summary);
			return { ok: true };
		case "land":
			return tower.land(flightId);
		case "checkout": {
			// Read-only, repo-scoped, 15-minute access for an external runner to clone or fetch.
			if (!f.artifact) throw new Error(`${flightId} has no repository yet`);
			return {
				remote: f.artifact.remote,
				readToken: await tower.readToken(flightId),
				head: await tower.git.resolve(flightRef(flightId)),
			};
		}
		case "refresh": {
			const ok = await tower.refresh(flightId);
			if (!ok) throw new Error("baseline refresh hit a Git conflict; a controller must resolve it");
			return { head: tower.flight(flightId).baseline };
		}
		case "fail":
			tower.mutate((c) => c.fail(flightId, req.reason));
			await tower.closeFlight(flightId);
			return { ok: true, phase: tower.flight(flightId).phase };
	}
}

export async function status(tower: Tower, flightId: string) {
	const f = tower.flight(flightId);
	const c = tower.state.traffic.clearances[flightId];
	const label = (r: string) => resourceLabel(r, tower.state.index);
	return {
		flightId,
		phase: f.phase,
		planVersion: f.plan?.planVersion ?? 0,
		clearance: c?.status ?? "none",
		cleared: c?.cleared.map(label) ?? [],
		held: c?.held.map((h) => ({ resource: label(h.resource), waitingOn: h.waitingOn, reason: h.reason })) ?? [],
		landAfter: c?.landAfter ?? [],
		stale: f.stale ?? null,
		baseline: f.baseline,
		head: await tower.git.resolve(flightRef(flightId)),
		artifact: f.artifact && f.finishedAt === undefined ? { repo: f.artifact.repo, remote: f.artifact.remote } : null,
		cleanup: f.cleanup ?? null,
		brief: clearanceBrief(tower.state, flightId),
		instruction: f.instruction ?? null,
	};
}
