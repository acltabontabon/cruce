import { ZodError } from "zod";
import { PUBLIC_ERRORS } from "./public-errors.ts";

export class DomainError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = `CruceError${status}`;
	}
}
export function requireValue<T>(value: T | null | undefined, message: string): T {
	if (value === undefined || value === null) throw new DomainError(400, message);
	return value;
}
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

/** Preserve intentional HTTP status across Durable Object RPC error serialization. */
export function domainStatus(error: unknown): number | undefined {
	if (error instanceof DomainError) return error.status;
	if (error instanceof Error && /^CruceError(400|401|403|404|405|409|410|413|415|429|502|503)$/.test(error.name))
		return Number(error.name.slice(10));
	return undefined;
}

/** Field names are schema vocabulary, never unknown keys or validation/provider text. */
const PUBLIC_FIELDS = new Set([
	"tool",
	"confirmation",
	"forgetStorage",
	"repository.delete",
	"namespaceId",
	"repositoryId",
	"workspaceId",
	"idempotencyKey",
	"title",
	"description",
	"baseRevision",
	"revision",
	"branch",
	"execution",
	"id",
	"checkoutId",
	"machineId",
	"kind",
	"owned",
	"changes",
	"path",
	"previousPath",
	"status",
	"binary",
	"commits",
	"cancelled",
	"artifactId",
	"proposalId",
	"subjectId",
	"content",
	"outcome",
	"reason",
	"reviewIndex",
	"humanAttested",
	"ref",
	"sourceView",
	"name",
	"handle",
	"defaultBranch",
	"userId",
	"role",
	"members",
	"email",
	"token",
	"grants",
	"subject",
	"policy",
	"protectedPaths",
	"requiredEvidence",
	"resourceRules",
	"rules",
	"repository.create",
	"workspace.fork",
	"workspace.cleanup",
	"revision.publish",
	"artifact.publish",
	"source.read",
]);

/** The sole public mapper for HTTP and MCP, including serialized Durable Object errors. */
export function publicError(error: unknown): { status: number; message: string } {
	const status = domainStatus(error);
	if (status && error instanceof Error && PUBLIC_ERRORS[status]?.includes(error.message)) return { status, message: error.message };
	if (error instanceof ZodError) {
		const field = error.issues[0]?.path.filter((part): part is string => typeof part === "string" && PUBLIC_FIELDS.has(part)).join(".");
		return { status: 400, message: `Invalid ${field || "request"}: check the supplied value` };
	}
	return { status: 500, message: "Operation unavailable; retry with the same operation identity" };
}
