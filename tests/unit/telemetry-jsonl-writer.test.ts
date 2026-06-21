import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendTelemetryEvent } from '../../packages/core/src/telemetry/jsonl-writer.js';

describe('telemetry JSONL writer', () => {
  it('redacts secret-like metadata before appending JSONL logs', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-telemetry-'));
    await mkdir(path.join(projectRoot, '.noemaloom'), { recursive: true });

    await appendTelemetryEvent(projectRoot, 'mcp', {
      tool: 'nl_query',
      status: 'pass',
      metadata: {
        apiKey: 'abcdefghijklmnop1234567890',
        nested: {
          message: 'password = "correct horse battery staple"',
          owner: 'admin@example.com'
        }
      }
    });

    const text = await readFile(path.join(projectRoot, '.noemaloom', 'logs', 'mcp.jsonl'), 'utf8');
    const record = JSON.parse(text.trim()) as { metadata: Record<string, unknown> };

    expect(text).toContain('[REDACTED:metadata]');
    expect(text).toContain('[REDACTED:password]');
    expect(text).toContain('[REDACTED:email]');
    expect(text).not.toContain('abcdefghijklmnop1234567890');
    expect(text).not.toContain('correct horse battery staple');
    expect(text).not.toContain('admin@example.com');
    expect(record.metadata.apiKey).toBe('[REDACTED:metadata]');
  });
});
