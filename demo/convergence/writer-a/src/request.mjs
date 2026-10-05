import { timeout } from "./timeout.mjs";

export function scheduleRequest(schedule) {
  schedule(timeout * 1000);
}
