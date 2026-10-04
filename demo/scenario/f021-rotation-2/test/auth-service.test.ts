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

test("refreshToken rotates the refresh token and records the new token id", () => {
	const { auth, audit, clock } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	clock.now += 60_000;
	const next = auth.refreshToken(pair.refreshToken);
	assert.ok(next);
	assert.notEqual(next.refreshToken, pair.refreshToken);
	const claims = auth.introspect(next.accessToken);
	assert.equal(claims?.sub, "ada");
	assert.equal(audit.ofType("token.refreshed")[0]?.detail, `jti=${claims?.jti}`);
});

test("reusing a rotated refresh token revokes the family", () => {
	const { auth, audit } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	const next = auth.refreshToken(pair.refreshToken);
	assert.ok(next);
	assert.equal(auth.refreshToken(pair.refreshToken), null);
	assert.equal(auth.refreshToken(next.refreshToken), null);
	assert.equal(audit.ofType("token.reuse-detected").length, 1);
});

test("logout revokes the refresh token", () => {
	const { auth } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	auth.logout(pair.refreshToken);
	assert.equal(auth.refreshToken(pair.refreshToken), null);
});
