import { AsyncLocalStorage } from "node:async_hooks";
import { publicError } from "../core/errors.ts";
import { type Command, RESOURCE_ACTIONS } from "../shared/platform.ts";
import { CRUCE_TOOLS, HUMAN_TOOLS } from "../shared/tools.ts";
import { hash } from "./store.ts";

const identifiers = [
	"namespaceId",
	"repositoryId",
	"workspaceId",
	"proposalId",
	"promotionId",
	"revision",
	"operationId",
	"reservationId",
] as const;
type Identifier = (typeof identifiers)[number];
export type DiagnosticContext = Partial<Record<Identifier, string>> & { tool?: string };
export function commandContext(cmd: Command, actorId: string): DiagnosticContext {
	return {
		tool: cmd.tool,
		namespaceId: cmd.namespaceId,
		repositoryId: cmd.repositoryId,
		workspaceId: cmd.workspaceId,
		proposalId: cmd.proposalId,
		revision: cmd.revision,
		operationId: cmd.idempotencyKey ? `${actorId}:${cmd.idempotencyKey}` : undefined,
	};
}
const context = new AsyncLocalStorage<DiagnosticContext>();
const tools = new Set([
	...CRUCE_TOOLS.map((t) => t.name),
	...HUMAN_TOOLS,
	"provision_repository",
	"git_receive_pack",
	"git_upload_pack",
	"export_source",
]);
const events = [
	"operation_started",
	"operation_completed",
	"operation_failed",
	"operation_replayed",
	"resource_reserved",
	"resource_settled",
	"promotion_phase",
	"provider_error",
	"boundary_error",
] as const;
const phases = ["reserved", "prepared", "attempted", "confirmed", "complete", "uncertain", "released", "failed"] as const;
const providerCodes = ["NOT_FOUND", "ALREADY_EXISTS", "RATE_LIMITED", "UNAUTHORIZED", "FORBIDDEN", "INTERNAL_ERROR", "UNKNOWN"] as const;
type Details = {
	phase?: (typeof phases)[number];
	action?: (typeof RESOURCE_ACTIONS)[number];
	transport?: "http" | "mcp";
	provider?: "binding" | "rest" | "git";
	code?: (typeof providerCodes)[number];
	status?: number;
	durationMs?: number;
};

/** Untrusted IDs/operation keys may contain secrets. Only deterministic, typed digests reach logs. */
export async function diagnosticId(field: Identifier, value: string) {
	return hash(`cruce-diagnostics-v1:${field}:${value}`);
}
async function redacted(value: DiagnosticContext): Promise<DiagnosticContext> {
	const safe: DiagnosticContext = {};
	for (const field of identifiers)
		if (typeof value[field] === "string" && value[field]) safe[field] = await diagnosticId(field, value[field]);
	if (value.tool && tools.has(value.tool)) safe.tool = value.tool;
	return safe;
}
export async function withDiagnostics<T>(value: DiagnosticContext, run: () => Promise<T>): Promise<T> {
	return context.run(await redacted(value), run);
}
export async function correlate(value: DiagnosticContext) {
	const current = context.getStore();
	if (current) Object.assign(current, await redacted(value));
}

/** Rebuild the log record from fixed keys and enums; never serialize errors, requests or provider bodies. */
export function diagnose(event: (typeof events)[number], details: Details = {}) {
	if (!events.includes(event)) return;
	const record: Record<string, unknown> = { event, ...context.getStore() };
	if (details.phase && phases.includes(details.phase)) record.phase = details.phase;
	if (details.action && RESOURCE_ACTIONS.includes(details.action)) record.action = details.action;
	if (details.transport && ["http", "mcp"].includes(details.transport)) record.transport = details.transport;
	if (details.provider && ["binding", "rest", "git"].includes(details.provider)) record.provider = details.provider;
	if (details.code && providerCodes.includes(details.code)) record.code = details.code;
	if (Number.isInteger(details.status) && details.status! >= 100 && details.status! <= 599) record.status = details.status;
	if (Number.isFinite(details.durationMs) && details.durationMs! >= 0) record.durationMs = Math.floor(details.durationMs!);
	console.log(JSON.stringify(record));
}
export function diagnoseError(event: "operation_failed" | "boundary_error", error: unknown, details: Details = {}) {
	diagnose(event, { ...details, status: publicError(error).status });
}

export function httpFailure(error: unknown): Response {
	const { status, message } = publicError(error);
	diagnoseError("boundary_error", error, { transport: "http" });
	return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
