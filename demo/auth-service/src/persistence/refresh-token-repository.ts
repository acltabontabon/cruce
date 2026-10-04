export interface RefreshTokenRecord {
	token: string;
	userId: string;
	expiresAt: number;
}

/** In-memory store of issued refresh tokens. */
export class RefreshTokenRepository {
	private readonly records = new Map<string, RefreshTokenRecord>();

	save(record: RefreshTokenRecord): void {
		this.records.set(record.token, { ...record });
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
}
