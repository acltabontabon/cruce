import assert from "node:assert/strict";
import { fixture } from "../test/browser/fixture.ts";

const first = await fixture();
const second = await fixture();
assert.equal(first.base, second.base);
assert.equal(first.head, second.head);
assert.notEqual(first.base, first.head);
console.log(`Fixed-clock workspace scenario verified: ${first.base} → ${first.head}`);
