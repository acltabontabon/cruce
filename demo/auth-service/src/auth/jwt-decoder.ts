import { createHmac, timingSafeEqual } from "node:crypto";

export interface DecodedToken {
	sub: string;
	exp: number;
	scope?: string[];
	jti?: string;
}

/** Minimal HS256 JWT codec. Signs and verifies compact JWS tokens with a shared secret. */
export class JwtDecoder {
	private readonly secret: string;

	constructor(secret: string) {
		this.secret = secret;
	}

	/** Returns the payload of a correctly signed token, or null. */
	decode(token: string): DecodedToken | null {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const [header, payload, signature] = parts;
		if (!safeEqual(signature, sign(`${header}.${payload}`, this.secret))) return null;
		try {
			return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DecodedToken;
		} catch {
			return null;
		}
	}

	encode(claims: DecodedToken): string {
		const header = base64url({ alg: "HS256", typ: "JWT" });
		const payload = base64url(claims);
		return `${header}.${payload}.${sign(`${header}.${payload}`, this.secret)}`;
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
