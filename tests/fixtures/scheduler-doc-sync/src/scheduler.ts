export type SchedulerOptions = {
  timeoutMs?: number;
};

export function createScheduler(options: SchedulerOptions = {}) {
  return { timeoutMs: options.timeoutMs ?? 1000 };
}
