export interface RefreshTokenRecord {
	token: string;
	userId: string;
	expiresAt: number;
	/** Every refresh token descends from one login; rotation keeps the family. */
	family?: string;
	usedAt?: number;
}

export type RotationResult =
	| { status: "rotated"; record: RefreshTokenRecord }
	| { status: "reused"; family: string }
	| { status: "unknown" };

/** In-memory store of issued refresh tokens, with single-use rotation and family revocation. */
export class RefreshTokenRepository {
	private readonly records = new Map<string, RefreshTokenRecord>();

	save(record: RefreshTokenRecord): void {
		this.records.set(record.token, { ...record, family: record.family ?? record.token });
	}

	find(token: string): RefreshTokenRecord | undefined {
		const record = this.records.get(token);
		return record ? { ...record } : undefined;
	}

	delete(token: string): boolean {
		return this.records.delete(token);
	}

	countForUser(userId: string): number {
		let count = 0;
		for (const record of this.records.values()) if (record.userId === userId) count++;
		return count;
	}

	/**
	 * Marks `token` used and stores `next` in the same family. Presenting an already-used token
	 * means it leaked: the whole family is revoked.
	 */
	rotate(token: string, next: RefreshTokenRecord, now: number = Date.now()): RotationResult {
		const current = this.records.get(token);
		if (!current) return { status: "unknown" };
		const family = current.family ?? current.token;
		if (current.usedAt !== undefined) {
			this.revokeFamily(family);
			return { status: "reused", family };
		}
		this.records.set(token, { ...current, usedAt: now });
		const record = { ...next, family };
		this.records.set(record.token, record);
		return { status: "rotated", record: { ...record } };
	}

	revokeFamily(family: string): number {
		let revoked = 0;
		for (const [token, record] of this.records) {
			if ((record.family ?? record.token) === family) {
				this.records.delete(token);
				revoked++;
			}
		}
		return revoked;
	}
}
