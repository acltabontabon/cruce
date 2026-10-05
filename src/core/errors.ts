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
