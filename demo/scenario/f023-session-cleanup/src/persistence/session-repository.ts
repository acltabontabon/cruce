export interface SessionRecord {
	id: string;
	userId: string;
	createdAt: number;
	lastSeenAt: number;
}

/** In-memory store of server-side sessions. */
export class SessionRepository {
	private readonly sessions = new Map<string, SessionRecord>();

	save(session: SessionRecord): void {
		this.sessions.set(session.id, { ...session });
	}

	find(id: string): SessionRecord | undefined {
		const session = this.sessions.get(id);
		return session ? { ...session } : undefined;
	}

	delete(id: string): boolean {
		return this.sessions.delete(id);
	}

	all(): SessionRecord[] {
		return [...this.sessions.values()].map((s) => ({ ...s }));
	}

	/** Deletes sessions not seen since `cutoff`. Returns the ids that were removed. */
	deleteIdleSince(cutoff: number): string[] {
		const removed: string[] = [];
		for (const [id, session] of this.sessions) {
			if (session.lastSeenAt < cutoff) {
				this.sessions.delete(id);
				removed.push(id);
			}
		}
		return removed;
	}
}
