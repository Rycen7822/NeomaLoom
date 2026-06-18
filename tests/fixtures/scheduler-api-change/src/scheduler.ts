export type SchedulerConfig = {
  timeout?: number;
};

export function createScheduler(config: SchedulerConfig = {}) {
  return { timeout: config.timeout ?? 30 };
}
