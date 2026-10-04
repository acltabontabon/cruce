import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystem } from "./support.ts";

test("login issues an access token and a refresh token", () => {
	const { auth } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	assert.equal(pair.expiresIn, 900);
	assert.equal(auth.login({ username: "ada", password: "nope" }), null);
});

test("introspect returns the claims of a valid access token", () => {
	const { auth } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	assert.equal(auth.introspect(pair.accessToken)?.sub, "ada");
	assert.equal(auth.introspect("not-a-token"), null);
});

test("refreshToken exchanges a refresh token for a new access token", () => {
	const { auth, clock } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	clock.now += 60_000;
	const next = auth.refreshToken(pair.refreshToken);
	assert.ok(next);
	assert.equal(auth.introspect(next.accessToken)?.sub, "ada");
});

test("logout revokes the refresh token", () => {
	const { auth } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	auth.logout(pair.refreshToken);
	assert.equal(auth.refreshToken(pair.refreshToken), null);
});
