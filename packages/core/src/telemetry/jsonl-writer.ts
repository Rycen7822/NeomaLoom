import path from 'node:path';

import { appendFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from '../state/state-dir.js';

export type TelemetryLogName = 'mcp' | 'refresh' | 'locator' | 'worker';

export type TelemetryEvent = {
  tool?: string;
  status: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

const TELEMETRY_LOG_NAMES: ReadonlySet<string> = new Set(['mcp', 'refresh', 'locator', 'worker']);

export async function appendTelemetryEvent(
  projectRoot: string,
  logName: TelemetryLogName,
  event: TelemetryEvent
): Promise<void> {
  if (!TELEMETRY_LOG_NAMES.has(logName)) {
    throw new Error(`Unknown telemetry log: ${logName}`);
  }

  const paths = await ensureStateDir(projectRoot);
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };

  await appendFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, `${logName}.jsonl`),
    `${JSON.stringify(record)}\n`
  );
}
