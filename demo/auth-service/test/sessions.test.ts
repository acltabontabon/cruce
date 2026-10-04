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
