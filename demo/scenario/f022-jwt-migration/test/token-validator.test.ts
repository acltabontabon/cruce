import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystem } from "./support.ts";

test("validate returns claims, including a token id, for a valid token", () => {
	const { decoder, validator, clock } = createSystem();
	const token = decoder.encode({ sub: "ada", exp: clock.now / 1000 + 60, scope: ["admin"] });
	const result = validator.validate(token);
	assert.equal(result.valid, true);
	assert.ok(result.valid);
	assert.equal(result.claims.sub, "ada");
	assert.deepEqual(result.claims.scope, ["admin"]);
	assert.match(result.claims.jti ?? "", /^[0-9a-f-]{36}$/);
});

test("validate explains why a token is rejected", () => {
	const { decoder, validator, clock } = createSystem();
	const token = decoder.encode({ sub: "ada", exp: clock.now / 1000 + 60 });
	assert.deepEqual(validator.validate("abc"), { valid: false, reason: "malformed" });
	assert.deepEqual(validator.validate(`${token}x`), { valid: false, reason: "signature" });
	clock.now += 120_000;
	assert.deepEqual(validator.validate(token), { valid: false, reason: "expired" });
});

test("decoder rejects tokens signed with an algorithm outside the allow-list", () => {
	const { decoder } = createSystem();
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ sub: "ada", exp: 1 })).toString("base64url");
	assert.deepEqual(decoder.verify(`${header}.${payload}.`), { ok: false, error: "unsupported-algorithm" });
});
