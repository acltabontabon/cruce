import { randomUUID } from "node:crypto";
import type { AuditLog } from "../messaging/audit-log.ts";
import type { SessionRecord, SessionRepository } from "../persistence/session-repository.ts";

/** Starts, refreshes, and ends server-side sessions. */
export class SessionService {
	private readonly sessions: SessionRepository;
	private readonly audit: AuditLog;
	private readonly now: () => number;

	constructor(sessions: SessionRepository, audit: AuditLog, now: () => number = Date.now) {
		this.sessions = sessions;
		this.audit = audit;
		this.now = now;
	}

	start(userId: string): SessionRecord {
		const session = { id: randomUUID(), userId, createdAt: this.now(), lastSeenAt: this.now() };
		this.sessions.save(session);
		this.audit.record({ type: "session.started", userId });
		return session;
	}

	touch(id: string): SessionRecord | undefined {
		const session = this.sessions.find(id);
		if (!session) return undefined;
		const updated = { ...session, lastSeenAt: this.now() };
		this.sessions.save(updated);
		return updated;
	}

	/** Ends every session idle for longer than `maxIdleMs`. Returns how many were cleaned up. */
	cleanupExpired(maxIdleMs: number): number {
		const removed = this.sessions.deleteIdleSince(this.now() - maxIdleMs);
		if (removed.length) this.audit.record({ type: "session.cleanup", userId: "system", detail: `removed=${removed.length}` });
		return removed.length;
	}

	end(id: string): boolean {
		const session = this.sessions.find(id);
		if (!session) return false;
		this.sessions.delete(id);
		this.audit.record({ type: "session.ended", userId: session.userId });
		return true;
	}
}
