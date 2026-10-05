import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleRetry } from "../src/retry.mjs";

test("retry waits two seconds", () => {
  let delay;
  scheduleRetry((milliseconds) => { delay = milliseconds; });
  assert.equal(delay, 2000);
});
