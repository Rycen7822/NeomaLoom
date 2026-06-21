import path from 'node:path';

import { appendFileInsideStateDir } from '../safety/path-guard.js';
import { redactText } from '../safety/redaction.js';
import { ensureStateDir } from '../state/state-dir.js';

export type TelemetryLogName = 'mcp' | 'refresh' | 'locator' | 'worker';

export type TelemetryEvent = {
  tool?: string;
  status: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

const TELEMETRY_LOG_NAMES: ReadonlySet<string> = new Set(['mcp', 'refresh', 'locator', 'worker']);
const SENSITIVE_METADATA_KEY = /(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)/i;
const MAX_METADATA_REDACTION_DEPTH = 8;
const MAX_METADATA_COLLECTION_ITEMS = 100;

function redactMetadataValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactText(value).redactedText;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_METADATA_REDACTION_DEPTH) {
    return '[REDACTED:metadata_depth]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_COLLECTION_ITEMS).map(item => redactMetadataValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_METADATA_COLLECTION_ITEMS)
      .map(([key, child]) => [
        key,
        SENSITIVE_METADATA_KEY.test(key)
          ? '[REDACTED:metadata]'
          : redactMetadataValue(child, depth + 1)
      ])
  );
}

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
    ...event,
    ...(event.metadata ? { metadata: redactMetadataValue(event.metadata) as Record<string, unknown> } : {})
  };

  await appendFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, `${logName}.jsonl`),
    `${JSON.stringify(record)}\n`
  );
}
