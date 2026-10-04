import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystem } from "./support.ts";

test("sessions can be started, touched, and ended", () => {
	const { sessions, sessionRepository, clock } = createSystem();
	const session = sessions.start("ada");
	clock.now += 1000;
	assert.equal(sessions.touch(session.id)?.lastSeenAt, clock.now);
	assert.equal(sessions.end(session.id), true);
	assert.equal(sessionRepository.find(session.id), undefined);
});

test("cleanupExpired ends only sessions idle beyond the limit", () => {
	const { sessions, sessionRepository, audit, clock } = createSystem();
	const stale = sessions.start("ada");
	clock.now += 31 * 60_000;
	const fresh = sessions.start("grace");
	assert.equal(sessions.cleanupExpired(30 * 60_000), 1);
	assert.equal(sessionRepository.find(stale.id), undefined);
	assert.ok(sessionRepository.find(fresh.id));
	assert.equal(audit.ofType("session.cleanup").length, 1);
});
