import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystem } from "./support.ts";

test("validate returns claims for a correctly signed, unexpired token", () => {
	const { decoder, validator, clock } = createSystem();
	const token = decoder.encode({ sub: "ada", exp: clock.now / 1000 + 60, scope: ["admin"] });
	assert.deepEqual(validator.validate(token), { sub: "ada", exp: clock.now / 1000 + 60, scope: ["admin"] });
});

test("validate rejects forged and expired tokens", () => {
	const { decoder, validator, clock } = createSystem();
	const token = decoder.encode({ sub: "ada", exp: clock.now / 1000 + 60 });
	assert.equal(validator.validate(`${token}x`), null);
	clock.now += 120_000;
	assert.equal(validator.validate(token), null);
});
