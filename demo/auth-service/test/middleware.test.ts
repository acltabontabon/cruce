import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystem } from "./support.ts";

test("public routes do not need a token", () => {
	const { middleware, config } = createSystem();
	const rule = config.ruleFor("/login");
	assert.ok(rule);
	assert.equal(middleware.requireAuth(undefined, rule).status, 200);
});

test("protected routes check the token and its scope", () => {
	const { auth, middleware, config } = createSystem();
	const pair = auth.login({ username: "ada", password: "lovelace" });
	assert.ok(pair);
	const sessions = config.ruleFor("/sessions");
	const admin = config.ruleFor("/admin");
	assert.ok(sessions && admin);
	assert.equal(middleware.requireAuth(undefined, sessions).status, 401);
	assert.equal(middleware.requireAuth(`Bearer ${pair.accessToken}`, sessions).status, 200);
	assert.equal(middleware.requireAuth(`Bearer ${pair.accessToken}`, admin).status, 403);
});
