import {
	type Command,
	type CoordinationState,
	type Decision,
	type Observation,
	type Principal,
	READ_TOOLS,
	type SemanticConstraint,
	type SystemConnection,
	type Workstream,
} from "../shared/coordination.ts";
import { type AirspaceIndex, isAncestorOrEqual, overlap, resolveResource } from "./airspace.ts";
import { DependencyGraph } from "./dependency-graph.ts";
import { type Flight, type FlightPlan, FlightPlanInput } from "./domain.ts";
import { evaluatePublish } from "./publish-gate.ts";
import { computeTraffic, planAccesses } from "./traffic.ts";

export class CoordinationError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export const SESSION_TTL = 90_000;
/** Stable input fingerprint; contains no credentials. Deliberately retains exact inputs for audit. */
export function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function initialCoordination(system: SystemConnection, index: AirspaceIndex): CoordinationState {
	return {
		system: structuredClone(system),
		index: structuredClone(index),
		revision: 0,
		counter: 0,
		workstreams: [],
		sessions: [],
		observations: [],
		semantic: [],
		overrides: [],
		replays: {},
		audit: [],
	};
}
export function inputFingerprint(s: CoordinationState): string {
	return stable({
		system: s.system,
		index: s.index.revision,
		plans: s.workstreams.map((w) => [w.id, w.plans.at(-1), w.state, w.staleRevision, w.released, w.publications]),
		semantic: s.semantic.filter((c) => c.automatic).map((c) => c.id),
	});
}
function asFlight(s: CoordinationState, w: Workstream): Flight {
	const p = w.plans.at(-1);
	const plan = p ? ({ ...p, flightId: w.id, planVersion: p.version, filedAt: p.at, baseline: p.baseline } as FlightPlan) : undefined;
	return {
		id: w.id,
		missionId: w.id,
		title: w.title,
		agent: "external",
		agentRuntime: "native",
		priority: "normal",
		phase: w.state === "integrated" ? "landed" : "executing",
		createdAt: w.createdAt,
		baseline: p?.baseline ?? s.index.revision,
		plan,
		planHistory: plan ? [plan] : [],
		publishes: w.publications.map((p) => ({
			at: 0,
			commit: p.head,
			approved: p.verified,
			touched: p.resources,
			outside: [],
			message: "Managed source publication",
		})),
		violations: 0,
	};
}
function liveWriter(s: CoordinationState, id: string, now: number) {
	return s.sessions.find((a) => a.workstreamId === id && a.role === "writer" && a.connected && a.expiresAt > now);
}
function intersect(a: string, b: string, index: AirspaceIndex) {
	return ["same", "contains"].includes(overlap(a, b, index));
}
function activeConstraint(s: CoordinationState, c: SemanticConstraint) {
	return c.automatic && c.fingerprint === semanticFingerprint(s);
}
export function semanticFingerprint(s: CoordinationState): string {
	return stable({
		system: s.system.version,
		head: s.system.canonicalHead,
		index: s.index.revision,
		plans: s.workstreams.map((w) => [w.id, w.plans.at(-1), w.sessions.at(-1), w.state]),
		policy: s.system.policy,
		observations: s.workstreams.map((w) => {
			const o = s.observations.filter((o) => o.workstreamIds.includes(w.id)).at(-1);
			return o ? [w.id, o.base, o.head, o.changes, o.verified, o.headIndex] : [w.id];
		}),
	});
}

/** Public declarations are compared at the exact diff base and head, including removals. */
export function changedContracts(o: Observation): string[] {
	return [
		...new Set(
			o.changes.flatMap((change) => {
				const before = o.index.files.find((f) => f.path === change.path)?.symbols.filter((s) => s.exported) ?? [];
				const after = o.headIndex.files.find((f) => f.path === change.path)?.symbols.filter((s) => s.exported) ?? [];
				return [
					...before.filter((s) => !after.some((a) => a.name === s.name && a.contract === s.contract)),
					...after.filter((s) => !before.some((b) => b.name === s.name && b.contract === s.contract)),
				].map((s) => `s:${change.path}#${s.name}`);
			}),
		),
	];
}

/** Scheduling may conservatively widen unknown symbols. Such a fallback never grants write permission. */
function permissionResources(plan: FlightPlan, index: AirspaceIndex): string[] {
	return [...plan.writeSet, ...plan.contractSet.map((c) => ({ type: "symbol" as const, resource: c.resource }))].flatMap((r) => {
		const resolved = resolveResource(r, index);
		return resolved.kind === r.type ? [resolved.id] : [];
	});
}
export function nativePlanAccesses(plan: FlightPlan, index: AirspaceIndex) {
	return planAccesses(plan, index).flatMap((access) => {
		if (access.mode !== "contract") return [access];
		const resolved = resolveResource({ type: "symbol", resource: access.requested }, index);
		if (!resolved.isNew || resolved.kind !== "module") return [access];
		const files = plan.writeSet.filter((r) => r.type === "file").map((r) => resolveResource(r, index).id);
		return files.length ? files.map((resource) => ({ ...access, resource })) : [access];
	});
}
function schedulingAccesses(flights: Flight[], index: AirspaceIndex) {
	return Object.fromEntries(flights.map((f) => [f.id, f.plan ? nativePlanAccesses(f.plan, index) : []]));
}

export function decide(s: CoordinationState, id: string, now: number, observation?: Observation): Decision {
	const w = s.workstreams.find((w) => w.id === id);
	if (!w) throw new CoordinationError(404, "Unknown workstream");
	const latest = observation ?? s.observations.filter((o) => o.workstreamIds.includes(id)).at(-1);
	const all = s.workstreams
		.filter((w) => w.state !== "integrated" && (w.state !== "completed" || w.publications.length))
		.map((w) => asFlight(s, w));
	const workFlights = all
		.filter((f) => liveWriter(s, f.id, now))
		.map((f) => {
			const released = s.workstreams.find((w) => w.id === f.id)?.released ?? [];
			if (!f.plan || !released.length) return f;
			return {
				...f,
				plan: {
					...f.plan,
					writeSet: f.plan.writeSet.filter((r) => !released.some((x) => isAncestorOrEqual(x, resolveResource(r, s.index).id, s.index))),
					contractSet: f.plan.contractSet.filter(
						(r) =>
							!released.some((x) => isAncestorOrEqual(x, resolveResource({ type: "symbol", resource: r.resource }, s.index).id, s.index)),
					),
				},
			};
		});
	const working = computeTraffic({
		index: s.index,
		flights: workFlights,
		accesses: schedulingAccesses(workFlights, s.index),
		overrides: [],
	});
	const publication = computeTraffic({
		index: s.index,
		flights: all.filter((f) => f.id === id || !latest?.verified || !latest.workstreamIds.includes(f.id)),
		accesses: schedulingAccesses(all, s.index),
		overrides: [],
	});
	const f = asFlight(s, w);
	const declaredWrites = f.plan
		? [...new Set([...permissionResources(f.plan, s.index), ...(latest ? permissionResources(f.plan, latest.headIndex) : [])])]
		: [];
	const writes = declaredWrites.filter((r) => !w.released.some((x) => isAncestorOrEqual(x, r, s.index)));
	const work = working.clearances[id];
	const pub = publication.clearances[id];
	const constrained: Decision["constrained"] = [];
	const reasons: Decision["reasons"] = [];
	for (const h of work?.held ?? [])
		if (writes.some((r) => intersect(h.resource, r, s.index)))
			constrained.push({ resource: h.resource, reason: h.reason, boundary: "working" });
	for (const h of pub?.held ?? [])
		if (declaredWrites.some((r) => intersect(h.resource, r, s.index)))
			constrained.push({ resource: h.resource, reason: h.reason, boundary: "publication" });
	const shared = liveWriter(s, id, now);
	if (shared)
		for (const other of s.sessions.filter(
			(a) =>
				a.id !== shared.id &&
				a.role === "writer" &&
				a.connected &&
				a.expiresAt > now &&
				a.workspace.checkoutId === shared.workspace.checkoutId,
		)) {
			for (const r of writes)
				constrained.push({
					resource: r,
					reason: `Shared physical checkout with ${other.workstreamId}; edits cannot be isolated`,
					boundary: "working",
				});
		}
	const depIds = new Set([...(f.plan?.dependencies ?? []), ...(pub?.landAfter ?? []).map((d) => d.flightId)]);
	for (const c of s.semantic.filter((c) => c.workstreamId === id && activeConstraint(s, c))) {
		if (c.response === "publication_dependency" && c.dependency) depIds.add(c.dependency);
		for (const r of c.resources)
			constrained.push({ resource: r, reason: `Semantic ${c.response}; evidence ${c.evidence.join(", ")}`, boundary: "publication" });
		reasons.push({ rule: `semantic:${c.capability}`, evidence: c.evidence, detail: c.response });
	}
	const dependencies: Decision["dependencies"] = [...depIds].sort().map((id) => {
		const dependency = s.workstreams.find((d) => d.id === id);
		const p = dependency?.publications.filter((p) => p.verified).at(-1);
		return {
			workstreamId: id,
			revision: p?.head,
			readiness: dependency?.state === "integrated" ? "promoted_canonical" : p ? "published_candidate" : "unpublished",
			reason: pub?.landAfter.find((d) => d.flightId === id)?.reason ?? "Declared or supported semantic dependency",
		};
	});
	for (const d of dependencies.filter(
		(d) => d.readiness !== "promoted_canonical" && !(latest?.verified && latest.workstreamIds.includes(d.workstreamId)),
	))
		for (const r of writes)
			constrained.push({ resource: r, reason: `Integration waits on ${d.workstreamId} (${d.readiness})`, boundary: "integration" });
	const publicationScope =
		latest && latest.workstreamIds.length > 1
			? latest.workstreamIds.flatMap((id) => {
					const other = s.workstreams.find((w) => w.id === id),
						plan = other ? asFlight(s, other).plan : undefined;
					return plan ? [...permissionResources(plan, latest.index), ...permissionResources(plan, latest.headIndex)] : [];
				})
			: declaredWrites;
	const declared = latest ? evaluatePublish(publicationScope, latest.changes, latest.index, { allowNewTests: false }) : undefined;
	// Inspect changed content too: additions can introduce new public symbols inside an existing file.
	const extraSymbols =
		latest?.headIndex.files
			.flatMap((file) => {
				const base = latest.index.files.find((f) => f.path === file.path);
				return file.symbols
					.filter((sym) => sym.exported && !base?.symbols.some((b) => b.name === sym.name))
					.map((sym) => `s:${file.path}#${sym.name}`);
			})
			.filter((r) => !publicationScope.some((w) => isAncestorOrEqual(w, r, latest?.headIndex ?? s.index))) ?? [];
	const declaredContracts = (latest?.workstreamIds.length ? latest.workstreamIds : [id]).flatMap(
		(id) =>
			s.workstreams
				.find((w) => w.id === id)
				?.plans.at(-1)
				?.contractSet.flatMap((c) =>
					[latest?.index ?? s.index, latest?.headIndex ?? s.index].flatMap((index) => {
						const resolved = resolveResource({ type: "symbol", resource: c.resource }, index);
						return resolved.kind === "symbol" ? [resolved.id] : [];
					}),
				) ?? [],
	);
	const contractDrift = latest
		? changedContracts(latest).filter((r) => !declaredContracts.some((c) => isAncestorOrEqual(c, r, latest.index)))
		: [];
	const drift = [...(declared?.outside.map((v) => v.resource) ?? []), ...extraSymbols, ...contractDrift];
	if (drift.length)
		for (const r of [...new Set(drift)])
			constrained.push({
				resource: r,
				reason: "Actual Git scope exceeds the filed plan; amend and re-coordinate",
				boundary: "publication",
			});
	if (w.staleRevision)
		for (const r of writes)
			constrained.push({ resource: r, reason: `Refresh plan against ${w.staleRevision}; preserve local changes`, boundary: "publication" });
	const cycle = new DependencyGraph(
		s.workstreams.map((w) => w.id),
		s.workstreams.flatMap((w) => w.plans.at(-1)?.dependencies.map((to) => ({ from: w.id, to, reason: "declared" })) ?? []),
	)
		.cycles()
		.some((c) => c.includes(id));
	if (cycle) reasons.push({ rule: "dependency-cycle", evidence: [id], detail: "Dependency cycle requires a revised plan" });
	const fingerprint = stable({ inputs: inputFingerprint(s), workstream: id, observation: latest?.id, constrained, dependencies });
	const overrides = s.overrides.filter((o) => o.workstreamId === id && o.fingerprint === fingerprint && o.expiresAt > now);
	const actual = latest ? evaluatePublish([], latest.changes, latest.index, { allowNewTests: false }).touched : undefined;
	const effective = constrained.filter(
		(c) =>
			(c.boundary === "working" ||
				!actual ||
				drift.includes(c.resource) ||
				w.staleRevision ||
				actual.some((r) => intersect(c.resource, r, latest?.index ?? s.index))) &&
			!overrides.some((o) => o.resources.some((r) => isAncestorOrEqual(r, c.resource, s.index))),
	);
	const cleared = writes.filter((r) => !effective.some((c) => c.boundary === "working" && intersect(c.resource, r, s.index)));
	let workingOutcome: Decision["working"] = !liveWriter(s, id, now)
		? "WAIT"
		: !cleared.length && writes.length
			? "WAIT"
			: effective.some((c) => c.boundary === "working")
				? "PROCEED_WITH_CONSTRAINTS"
				: "PROCEED";
	if (cycle) workingOutcome = "REPLAN";
	const publicationOutcome: Decision["publication"] = !f.plan
		? "BLOCK"
		: drift.length || w.staleRevision
			? "REPLAN"
			: effective.some((c) => c.boundary === "publication")
				? "WAIT"
				: latest
					? "PROCEED"
					: "BLOCK";
	const integrationOutcome: Decision["integration"] =
		publicationOutcome !== "PROCEED"
			? publicationOutcome
			: effective.some((c) => c.boundary === "integration")
				? "WAIT"
				: s.system.policy.mode === "enforced" && !latest?.verified
					? "BLOCK"
					: "PROCEED";
	for (const c of publication.congestions.filter((c) => c.flights.includes(id)))
		reasons.push({ rule: c.rightOfWay?.rule ?? c.control, evidence: c.resources, detail: c.why.join(" ") });
	if (!latest?.verified)
		reasons.push({
			rule: "local-preflight",
			evidence: latest ? [latest.id] : [],
			detail: "Source revision has not been verified at the managed publication boundary",
		});
	const limits = [
		...(latest?.limitations ?? []),
		...(!latest?.verified ? ["Local observation only; source publication and promotion require independent boundary verification"] : []),
		...(!f.plan ? ["Intent coverage unavailable"] : []),
	];
	const exhausted = w.instructions.some((i) => !i.resolvedAt && i.responses.filter((r) => r.outcome === "cannot_progress").length >= 3);
	const semanticAttention = s.semantic.filter(
		(c) => c.workstreamId === id && c.response === "escalate" && c.fingerprint === semanticFingerprint(s),
	);
	for (const concern of semanticAttention)
		reasons.push({
			rule: `semantic:${concern.capability}:human`,
			evidence: concern.evidence,
			detail: "Consequential or unsupported semantic concern requires human review",
		});
	if (exhausted)
		reasons.push({
			rule: "adaptation-exhausted",
			evidence: w.instructions.filter((i) => !i.resolvedAt).map((i) => i.id),
			detail: "Three unsuccessful responses to this unchanged constraint require human attention",
		});
	const nextAction =
		exhausted || semanticAttention.length
			? "human_review"
			: cycle
				? "amend_plan"
				: drift.length
					? "amend_scope"
					: w.staleRevision
						? "refresh_and_amend"
						: effective.some((c) => c.boundary === "working")
							? cleared.length
								? "continue_cleared_scope"
								: "wait_dependency"
							: dependencies.some((d) => d.readiness !== "promoted_canonical")
								? "prepare_against_candidate_wait_for_promotion"
								: "continue";
	return {
		displayStatus:
			exhausted || semanticAttention.length || drift.length || cycle
				? "Needs attention"
				: w.state !== "active"
					? "Ready"
					: workingOutcome === "WAIT"
						? "Waiting"
						: workingOutcome === "PROCEED_WITH_CONSTRAINTS" || effective.length || w.staleRevision
							? "Coordinated"
							: "Working safely",
		workstreamId: id,
		workstreamVersion: w.version,
		planVersion: w.plans.at(-1)?.version ?? 0,
		working: workingOutcome,
		publication: publicationOutcome,
		integration: integrationOutcome,
		cleared,
		constrained: effective,
		dependencies,
		reasons,
		nextAction,
		revision: s.revision,
		fingerprint,
		validity: {
			systemVersion: s.system.version,
			canonicalHead: s.system.canonicalHead,
			planVersions: Object.fromEntries(s.workstreams.map((w) => [w.id, w.plans.at(-1)?.version ?? 0])),
			expiresAt: now + SESSION_TTL,
		},
		coverage: {
			capabilities: [
				...new Set([
					...(shared?.workspace.capabilities ?? s.system.capabilities).filter((c) => c === "intent_mcp" || c === "git_observation"),
					...(latest?.verified && latest.source === "managed_git" ? ["managed_artifacts" as const] : []),
					...(s.system.capabilities.includes("native_promotion") ? ["native_promotion" as const] : []),
				]),
			],
			limitations: [...new Set(limits)],
			intent: !!f.plan,
		},
		instructions: w.instructions.filter((i) => !i.resolvedAt),
		overridden: overrides.length > 0,
		human: `${workingOutcome === "PROCEED" ? "Working safely" : workingOutcome === "PROCEED_WITH_CONSTRAINTS" ? "Coordinated" : "Needs coordination"}. ${nextAction.replaceAll("_", " ")}.`,
	};
}

export class WorkstreamController {
	readonly state: CoordinationState;
	constructor(
		state: CoordinationState,
		readonly now: number,
	) {
		this.state = structuredClone(state);
	}
	authorize(p: Principal) {
		const r = this.state.system;
		if (!r.active || p.tenantId !== r.tenantId || !p.systemIds.includes(r.id)) throw new CoordinationError(403, "System access denied");
	}
	private next(prefix: string) {
		return `${prefix}-${++this.state.counter}`;
	}
	private work(id?: string) {
		const w = this.state.workstreams.find((w) => w.id === id);
		if (!w) throw new CoordinationError(404, "Unknown workstream");
		return w;
	}
	private writer(w: Workstream, p: Principal, cmd: Command) {
		if (p.canWrite === false) throw new CoordinationError(403, "System contribution access was revoked");
		const a = this.state.sessions.find((a) => a.id === cmd.sessionId && a.workstreamId === w.id && a.developerId === p.developerId);
		if (a?.role !== "writer" || !a.connected || a.expiresAt <= this.now)
			throw new CoordinationError(409, "Attach a current writer session before changing this workstream");
		a.expiresAt = this.now + SESSION_TTL;
	}
	private attach(w: Workstream, p: Principal, cmd: Command) {
		if (!cmd.agent || !cmd.workspace) throw new CoordinationError(400, "Agent and workspace required");
		if (w.state === "integrated") throw new CoordinationError(409, "Integrated workstream is closed; register new work");
		w.state = "active";
		const live = liveWriter(this.state, w.id, this.now);
		if (cmd.agent.role === "writer" && live && (live.developerId !== p.developerId || live.instance !== cmd.agent.instance))
			throw new CoordinationError(409, "A writer is already attached; release or wait for its reservation to expire");
		if (live?.instance === cmd.agent.instance && live.developerId === p.developerId) {
			live.expiresAt = this.now + SESSION_TTL;
			return live.id;
		}
		const id = this.next("S");
		this.state.sessions.push({
			id,
			developerId: p.developerId,
			tool: cmd.agent.tool,
			instance: cmd.agent.instance,
			role: cmd.agent.role,
			workstreamId: w.id,
			workspace: cmd.workspace,
			expiresAt: this.now + SESSION_TTL,
			connected: true,
		});
		w.sessions.push(id);
		w.version++;
		if (w.plans.at(-1)?.baseline !== this.state.system.canonicalHead) w.staleRevision = this.state.system.canonicalHead;
		return id;
	}
	execute(cmd: Command, p: Principal): unknown {
		this.authorize(p);
		if (!READ_TOOLS.has(cmd.tool) && p.canWrite === false)
			throw new CoordinationError(403, "System contribution permission required for participation");
		if (cmd.systemId !== this.state.system.id) throw new CoordinationError(403, "System authority mismatch");
		const request = stable(cmd),
			replayKey = `${p.developerId}:${cmd.idempotencyKey}`;
		if (!READ_TOOLS.has(cmd.tool)) {
			if (!cmd.idempotencyKey) throw new CoordinationError(400, "Mutation requires an idempotency key");
			const old = this.state.replays[replayKey];
			if (old) {
				if (old.request !== request) throw new CoordinationError(409, "Idempotency key reused with different inputs");
				return old.result;
			}
		}
		if (cmd.tool === "get_system_context")
			return { system: this.state.system, index: this.state.index, capabilities: this.state.system.capabilities };
		if (cmd.tool === "get_active_work")
			return {
				workstreams: this.state.workstreams.map((w) => ({
					id: w.id,
					title: w.title,
					state: w.state,
					plan: w.plans.at(-1),
					decision: decide(this.state, w.id, this.now),
				})),
			};
		if (cmd.tool === "register_intent") {
			if (!cmd.plan) throw new CoordinationError(400, "Plan required");
			const fields = FlightPlanInput.parse(cmd.plan),
				id = this.next("W");
			if (fields.dependencies.some((id) => !this.state.workstreams.some((w) => w.id === id)))
				throw new CoordinationError(400, "Dependencies must reference known workstreams");
			const w: Workstream = {
				id,
				owner: p.developerId,
				version: 1,
				title: fields.summary,
				state: "active",
				plans: [{ ...fields, version: 1, at: this.now, baseline: cmd.workspace?.base ?? this.state.index.revision }],
				sessions: [],
				publications: [],
				instructions: [],
				released: [],
				createdAt: this.now,
			};
			this.state.workstreams.push(w);
			const sessionId = this.attach(w, p, cmd);
			this.finish(cmd, p, id);
			return this.replay(replayKey, request, { ...decide(this.state, id, this.now), sessionId });
		}
		const w = this.work(cmd.workstreamId);
		if (READ_TOOLS.has(cmd.tool)) {
			const a = this.state.sessions.find((a) => a.id === cmd.sessionId && a.developerId === p.developerId && a.workstreamId === w.id);
			if (a?.connected && a.expiresAt > this.now) a.expiresAt = this.now + SESSION_TTL;
			const d = decide(this.state, w.id, this.now);
			return cmd.tool === "get_dependencies" ? { workstreamId: w.id, dependencies: d.dependencies } : d;
		}
		if (cmd.expectedVersion === undefined || cmd.expectedPlanVersion === undefined)
			throw new CoordinationError(400, "Mutation requires workstream and plan versions");
		if (cmd.expectedVersion !== w.version || cmd.expectedPlanVersion !== (w.plans.at(-1)?.version ?? 0))
			throw new CoordinationError(409, "Plan or workstream changed; refresh coordination");
		if (cmd.tool !== "attach_workstream") this.writer(w, p, cmd);
		let sessionId = cmd.sessionId;
		if (cmd.tool === "attach_workstream") sessionId = this.attach(w, p, cmd);
		if (cmd.tool === "update_intent" || cmd.tool === "report_scope") {
			if (!cmd.plan) throw new CoordinationError(400, "Amended plan required");
			const fields = FlightPlanInput.parse(cmd.plan);
			if (fields.dependencies.includes(w.id) || fields.dependencies.some((id) => !this.state.workstreams.some((w) => w.id === id)))
				throw new CoordinationError(400, "Dependencies must reference other known workstreams");
			const graph = new DependencyGraph(
				this.state.workstreams.map((w) => w.id),
				this.state.workstreams.flatMap((other) =>
					(other.id === w.id ? fields.dependencies : (other.plans.at(-1)?.dependencies ?? [])).map((to) => ({
						from: other.id,
						to,
						reason: "declared",
					})),
				),
			);
			if (graph.cycles().length) throw new CoordinationError(409, "Plan introduces a dependency cycle");
			const base =
				cmd.workspace?.base ??
				this.state.sessions.find((a) => a.id === cmd.sessionId)?.workspace.base ??
				w.plans.at(-1)?.baseline ??
				this.state.index.revision;
			w.plans.push({ ...fields, version: w.plans.length + 1, baseline: base, at: this.now });
			w.title = fields.summary;
			w.version++;
			w.released = [];
			if (!w.staleRevision || base === w.staleRevision) {
				w.staleRevision = undefined;
				for (const i of w.instructions.filter((i) => !i.resolvedAt)) i.resolvedAt = this.now;
			}
		}
		if (cmd.tool === "report_change") throw new CoordinationError(400, "Observation must be derived by the application adapter");
		if (cmd.tool === "acknowledge_coordination" || cmd.tool === "respond_to_review") {
			const i = w.instructions.find((i) => i.id === cmd.instructionId && !i.resolvedAt);
			if (!i) throw new CoordinationError(409, "Instruction is absent or superseded");
			if (cmd.tool === "acknowledge_coordination") i.receivedAt ??= this.now;
			else {
				if (!cmd.response) throw new CoordinationError(400, "Response outcome required");
				i.responses.push({ at: this.now, outcome: cmd.response, detail: cmd.detail ?? "" });
			}
		}
		if (cmd.tool === "release_scope") {
			w.released = [...new Set([...w.released, ...(cmd.resources ?? [])])];
			if (!cmd.resources?.length)
				for (const a of this.state.sessions.filter((a) => a.workstreamId === w.id && a.id === cmd.sessionId)) a.connected = false;
			w.version++;
		}
		if (cmd.tool === "complete_workstream") {
			w.state = "completed";
			w.version++;
			for (const a of this.state.sessions.filter((a) => a.workstreamId === w.id)) a.connected = false;
		}
		this.finish(cmd, p, w.id);
		const result = { ...decide(this.state, w.id, this.now), sessionId };
		return this.replay(replayKey, request, result);
	}
	private replay(key: string, request: string, result: unknown) {
		this.state.replays[key] = { request, result };
		return result;
	}
	private finish(cmd: Command, p: Principal, id: string) {
		this.state.revision++;
		this.state.audit.push({ at: this.now, actor: p.developerId, command: cmd.tool, workstreamId: id, detail: cmd.detail ?? "" });
		for (const w of this.state.workstreams) this.adapt(w.id);
	}
	private adapt(id: string) {
		const w = this.work(id),
			d = decide(this.state, id, this.now);
		if (d.nextAction === "continue" || w.state !== "active") return;
		const kind =
			d.nextAction === "amend_scope"
				? "amend"
				: d.nextAction === "refresh_and_amend"
					? "refresh"
					: d.nextAction === "amend_plan"
						? "review"
						: d.nextAction === "continue_cleared_scope"
							? "continue"
							: "wait";
		if (!w.instructions.some((i) => i.fingerprint === d.fingerprint && !i.resolvedAt)) {
			for (const i of w.instructions.filter((i) => !i.resolvedAt)) i.resolvedAt = this.now;
			w.instructions.push({
				id: this.next("I"),
				kind,
				fingerprint: d.fingerprint,
				resources: d.constrained.map((c) => c.resource),
				requiredRevision: w.staleRevision,
				responses: [],
			});
		}
	}
	observe(o: Observation, p: Principal, cmd?: Command) {
		this.authorize(p);
		if (cmd) {
			const key = `${p.developerId}:${cmd.idempotencyKey}`,
				request = stable(cmd),
				old = this.state.replays[key];
			if (!cmd.idempotencyKey) throw new CoordinationError(400, "Observation requires idempotency key");
			if (old) {
				if (old.request !== request) throw new CoordinationError(409, "Idempotency key reused");
				return old.result;
			}
			const w = this.work(cmd.workstreamId);
			this.writer(w, p, cmd);
			if (cmd.expectedVersion !== w.version || cmd.expectedPlanVersion !== w.plans.at(-1)?.version)
				throw new CoordinationError(409, "Plan or workstream changed");
		}
		const previous = this.state.observations.some((old) => old.verified && old.head === o.head && old.base === o.base);
		if (!this.state.observations.some((old) => old.id === o.id)) this.state.observations.push(o);
		this.state.revision++;
		for (const id of o.workstreamIds) {
			const w = this.work(id);
			if (o.verified && !w.publications.some((p) => p.head === o.head))
				w.publications.push({
					planVersion: w.plans.at(-1)?.version,
					head: o.head,
					base: o.base,
					verified: true,
					integrated: false,
					observationId: o.id,
					resources: evaluatePublish([], o.changes, o.index, { allowNewTests: false }).touched,
				});
			this.adapt(id);
			if (o.verified && !previous) {
				const contracts = changedContracts(o);
				for (const other of this.state.workstreams.filter((other) => other.id !== id && other.state !== "integrated")) {
					const plan = asFlight(this.state, other).plan;
					if (
						plan &&
						plan.baseline !== o.head &&
						nativePlanAccesses(plan, o.index).some((a) => contracts.some((r) => intersect(a.resource, r, o.index)))
					) {
						other.staleRevision = o.head;
						other.version++;
						this.adapt(other.id);
					}
				}
			}
		}
		const result = o.workstreamIds[0] ? decide(this.state, o.workstreamIds[0], this.now, o) : { observed: true };
		if (cmd) this.replay(`${p.developerId}:${cmd.idempotencyKey}`, stable(cmd), result);
		return result;
	}
	canonical(head: string, index: AirspaceIndex, integratedHeads: string[], resources: string[]) {
		const old = this.state.system.canonicalHead;
		this.state.system.canonicalHead = head;
		this.state.index = index;
		if (old !== head) this.state.system.version++;
		for (const w of this.state.workstreams) {
			for (const p of w.publications) if (integratedHeads.includes(p.head)) p.integrated = true;
			if (
				w.publications.at(-1)?.integrated &&
				(w.publications.at(-1)?.planVersion ?? w.plans.at(-1)?.version) === w.plans.at(-1)?.version
			) {
				w.state = "integrated";
				w.version++;
			} else if (
				old !== head &&
				w.plans.at(-1) &&
				nativePlanAccesses(asFlight(this.state, w).plan as FlightPlan, index).some((a) =>
					resources.some((r) => intersect(a.resource, r, index)),
				)
			) {
				w.staleRevision = head;
				w.version++;
				this.adapt(w.id);
			}
		}
		this.state.revision++;
	}
	applySemantic(c: SemanticConstraint, evaluationPassed: boolean) {
		if (c.fingerprint !== semanticFingerprint(this.state)) return false;
		const w = this.work(c.workstreamId),
			resolved = nativePlanAccesses(asFlight(this.state, w).plan as FlightPlan, this.state.index).map((a) => a.resource);
		if (
			(c.response !== "escalate" && (!c.resources.length || !c.evidence.length)) ||
			c.resources.some((r) => !resolved.includes(r)) ||
			!Number.isFinite(c.probability) ||
			c.probability < 0 ||
			c.probability > 1
		)
			throw new CoordinationError(400, "Unsupported semantic evidence or resources");
		if (c.dependency && (!this.state.workstreams.some((w) => w.id === c.dependency) || c.dependency === w.id))
			throw new CoordinationError(400, "Invalid semantic dependency");
		const edges = this.state.workstreams
			.flatMap((w) => (w.plans.at(-1)?.dependencies ?? []).map((to) => ({ from: w.id, to, reason: "declared" })))
			.concat(
				this.state.semantic
					.filter((c) => c.automatic && c.dependency)
					.map((c) => ({ from: c.workstreamId, to: c.dependency as string, reason: "semantic" })),
			);
		if (c.dependency) edges.push({ from: w.id, to: c.dependency, reason: "semantic" });
		c.automatic =
			this.state.system.policy.semantic === "automatic" &&
			evaluationPassed &&
			c.probability >= 0.95 &&
			c.response !== "escalate" &&
			new DependencyGraph(
				this.state.workstreams.map((w) => w.id),
				edges,
			).cycles().length === 0;
		this.state.semantic = this.state.semantic.filter((old) => old.id !== c.id).concat(c);
		this.state.revision++;
		this.adapt(w.id);
		this.state.audit.push({
			at: this.now,
			actor: "jev",
			command: "semantic_assessment",
			workstreamId: w.id,
			detail: `${c.capability}: ${c.response}; ${c.model}; ${c.automatic ? "scoped constraint" : "advisory"}; evidence ${c.evidence.join(", ")}`,
		});
		return true;
	}
	override(p: Principal, id: string, resources: string[], reason: string, fingerprint: string, expiresAt: number) {
		this.authorize(p);
		if (!p.maintainer) throw new CoordinationError(403, "Maintainer required");
		const d = decide(this.state, id, this.now);
		if (d.fingerprint !== fingerprint) throw new CoordinationError(409, "Decision changed; inspect current evidence");
		if (
			!reason.trim() ||
			!resources.length ||
			expiresAt <= this.now ||
			expiresAt > this.now + 24 * 60 * 60 * 1000 ||
			resources.some((r) => !d.constrained.some((c) => c.resource === r))
		)
			throw new CoordinationError(400, "Scoped reason and expiration required");
		this.state.overrides.push({
			id: this.next("O"),
			workstreamId: id,
			actor: p.developerId,
			reason,
			resources,
			fingerprint,
			at: this.now,
			expiresAt,
		});
		this.state.revision++;
		this.state.audit.push({ at: this.now, actor: p.developerId, command: "override", workstreamId: id, detail: reason });
		return decide(this.state, id, this.now);
	}
}
