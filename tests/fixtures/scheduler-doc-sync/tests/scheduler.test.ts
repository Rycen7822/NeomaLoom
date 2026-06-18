import { createScheduler } from "../src/scheduler.js";

test("creates scheduler", () => {
  createScheduler({ timeoutMs: 25 });
});
