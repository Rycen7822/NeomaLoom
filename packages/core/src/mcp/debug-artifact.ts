import { createHash } from 'node:crypto';
import path from 'node:path';

import { writeFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from '../state/state-dir.js';

export type McpDebugArtifactRef = {
  path: string;
  sha256: string;
  bytes: number;
};

function safeToolSegment(tool: string): string {
  return tool.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
}

function timestampSegment(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function writeMcpDebugArtifact(input: {
  projectRoot: string;
  tool: string;
  responseProfile: string;
  data: unknown;
  evidence?: unknown;
  warnings?: unknown;
  nextActions?: unknown;
}): Promise<McpDebugArtifactRef> {
  const paths = await ensureStateDir(input.projectRoot);
  const createdAt = new Date();
  const payload = {
    schemaVersion: 1,
    tool: input.tool,
    responseProfile: input.responseProfile,
    createdAt: createdAt.toISOString(),
    data: input.data,
    evidence: input.evidence ?? [],
    warnings: input.warnings ?? [],
    nextActions: input.nextActions ?? []
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const sha256 = createHash('sha256').update(text).digest('hex');
  const relativePath = path.join(
    '.noemaloom',
    'artifacts',
    'mcp',
    safeToolSegment(input.tool),
    `${timestampSegment(createdAt)}-${sha256.slice(0, 12)}.json`
  );
  const absolutePath = path.join(paths.projectRoot, relativePath);
  await writeFileInsideStateDir(paths.projectRoot, absolutePath, text);
  return {
    path: relativePath.replaceAll('\\', '/'),
    sha256,
    bytes: Buffer.byteLength(text, 'utf8')
  };
}
