import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleRequest } from "../src/request.mjs";

test("request waits one second", () => {
  let delay;
  scheduleRequest((milliseconds) => { delay = milliseconds; });
  assert.equal(delay, 1000);
});
