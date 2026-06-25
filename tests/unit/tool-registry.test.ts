import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

describe('NoemaLoom tool registry', () => {
  it('rejects oversized passthrough payloads before dispatch', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-payload-'));

    const result = await callRegisteredTool('nl_status', {
      projectPath: projectRoot,
      extra: 'x'.repeat(1_100_000)
    });

    expect(result.ok).toBe(false);
    expect(result.graphState).toBe('error');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'payload_too_large', severity: 'error' })
    ]);
    expect(result.data).toMatchObject({ status: 'payload_too_large' });
  });
});