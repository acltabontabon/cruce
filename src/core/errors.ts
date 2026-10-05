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
	if (error instanceof Error && /^CruceError(400|401|403|404|405|409|413|429|502|503)$/.test(error.name))
		return Number(error.name.slice(10));
	return undefined;
}

/**
 * The only error text that crosses the HTTP or MCP boundary. Domain errors carry authored, safe messages;
 * validation errors name the offending field; anything else is reported generically and logged by the caller.
 */
export function publicError(error: unknown): { status: number; message: string } {
	const status = domainStatus(error);
	if (status) return { status, message: (error as Error).message };
	const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
	if (error instanceof Error && error.name === "ZodError" && Array.isArray(issues)) {
		const first = issues[0];
		return { status: 400, message: first ? `Invalid ${first.path.join(".") || "request"}: ${first.message}` : "Invalid request" };
	}
	return { status: 500, message: "Operation unavailable; retry with the same operation identity" };
}
