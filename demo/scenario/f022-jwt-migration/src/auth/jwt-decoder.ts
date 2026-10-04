import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface DecodedToken {
	sub: string;
	exp: number;
	scope?: string[];
	jti?: string;
	iss?: string;
}

export type DecodeFailure = "malformed" | "unsupported-algorithm" | "signature";

export type DecodeResult = { ok: true; token: DecodedToken } | { ok: false; error: DecodeFailure };

export interface JwtDecoderOptions {
	issuer?: string;
	algorithms?: string[];
}

/**
 * HS256 JWT codec with an explicit algorithm allow-list and typed verification failures.
 * Every issued token carries a unique `jti`.
 */
export class JwtDecoder {
	private readonly secret: string;
	private readonly issuer: string | undefined;
	private readonly algorithms: string[];

	constructor(secret: string, options: JwtDecoderOptions = {}) {
		this.secret = secret;
		this.issuer = options.issuer;
		this.algorithms = options.algorithms ?? ["HS256"];
	}

	verify(token: string): DecodeResult {
		const parts = token.split(".");
		if (parts.length !== 3) return { ok: false, error: "malformed" };
		const [header, payload, signature] = parts;
		const parsedHeader = parse<{ alg?: string }>(header);
		if (!parsedHeader) return { ok: false, error: "malformed" };
		if (!parsedHeader.alg || !this.algorithms.includes(parsedHeader.alg)) return { ok: false, error: "unsupported-algorithm" };
		if (!safeEqual(signature, sign(`${header}.${payload}`, this.secret))) return { ok: false, error: "signature" };
		const claims = parse<DecodedToken>(payload);
		if (!claims) return { ok: false, error: "malformed" };
		return { ok: true, token: claims };
	}

	/** Payload of a correctly signed token, or null. Prefer verify(), which explains failures. */
	decode(token: string): DecodedToken | null {
		const result = this.verify(token);
		return result.ok ? result.token : null;
	}

	encode(claims: DecodedToken): string {
		const header = base64url({ alg: "HS256", typ: "JWT" });
		const payload = base64url({ ...claims, jti: claims.jti ?? randomUUID(), ...(this.issuer ? { iss: this.issuer } : {}) });
		return `${header}.${payload}.${sign(`${header}.${payload}`, this.secret)}`;
	}
}

function parse<T>(segment: string): T | null {
	try {
		return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
	} catch {
		return null;
	}
}

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(input: string, secret: string): string {
	return createHmac("sha256", secret).update(input).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
