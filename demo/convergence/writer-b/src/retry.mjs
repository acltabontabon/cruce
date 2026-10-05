import { timeout } from "./timeout.mjs";

export function scheduleRetry(schedule) {
  schedule(timeout * 2);
}
