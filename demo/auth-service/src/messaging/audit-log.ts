export interface AuditEvent {
	type: string;
	userId: string;
	detail?: string;
	at?: number;
}

/** Append-only audit trail. */
export class AuditLog {
	private readonly events: AuditEvent[] = [];
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	record(event: AuditEvent): void {
		this.events.push({ ...event, at: event.at ?? this.now() });
	}

	ofType(type: string): AuditEvent[] {
		return this.events.filter((e) => e.type === type);
	}

	get size(): number {
		return this.events.length;
	}
}
