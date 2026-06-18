import { createScheduler } from "../src/scheduler.js";

test("uses timeout", () => {
  createScheduler({ timeout: 30 });
});
