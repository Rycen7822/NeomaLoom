import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { loadOrCreateConfig } from '../../config/config-loader.js';
import { resolveNoemaLoomPaths } from '../../state/paths.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

export const nlStatusInputSchema = z
  .object({
    projectPath: z.string().optional(),
    includeRepositoryMap: z.boolean().default(false)
  })
  .passthrough();

type IndexState = 'missing' | 'ready' | 'stale';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function countJsonArray(targetPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(targetPath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function stateFromPresence(present: boolean): IndexState {
  return present ? 'ready' : 'missing';
}

export async function handleNlStatus(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlStatusInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const configResult = await loadOrCreateConfig(projectRoot);

  if (!configResult.ok) {
    return createEnvelope({
      ok: false,
      tool: 'nl_status',
      projectRoot,
      graphState: 'error',
      warnings: configResult.errors.map(error => ({
        code: 'config_invalid',
        severity: 'error' as const,
        message: `${error.field}: ${error.message}`
      })),
      data: {
        status: 'config_invalid',
        errors: configResult.errors
      }
    });
  }

  const paths = resolveNoemaLoomPaths(projectRoot);
  const [
    hasFileInventory,
    hasSpanIndex,
    hasFactIndex,
    hasDocumentIndex,
    hasFeatureProjection,
    hasDerivedMap
  ] = await Promise.all([
    exists(path.join(paths.filesDir, 'inventory.sqlite')),
    exists(path.join(paths.spansDir, 'spans.db')),
    exists(path.join(paths.factDir, 'codegraph.db')),
    exists(path.join(paths.documentsDir, 'anchor-index.json')),
    exists(path.join(paths.planningDir, 'features.json')),
    exists(path.join(paths.derivedMapDir, 'repository-map.json'))
  ]);

  const anyReady = [
    hasFileInventory,
    hasSpanIndex,
    hasFactIndex,
    hasDocumentIndex,
    hasFeatureProjection,
    hasDerivedMap
  ].some(Boolean);
  const featureCount = hasFeatureProjection
    ? await countJsonArray(path.join(paths.planningDir, 'features.json'))
    : 0;

  return createEnvelope({
    ok: true,
    tool: 'nl_status',
    projectRoot,
    graphState: anyReady ? 'partial' : 'empty',
    data: {
      stateDir: '.noemaloom',
      fileInventory: { state: stateFromPresence(hasFileInventory), files: 0 },
      spanIndex: { state: stateFromPresence(hasSpanIndex), spans: 0, edges: 0 },
      factIndex: { state: stateFromPresence(hasFactIndex), symbols: 0, edges: 0 },
      documentIndex: { state: stateFromPresence(hasDocumentIndex), blocks: 0, parseErrors: 0 },
      artifactIndex: { state: 'missing' as const, entries: 0 },
      featureProjection: { state: stateFromPresence(hasFeatureProjection), features: featureCount },
      derivedMap: { state: stateFromPresence(hasDerivedMap), tokens: 0 },
      rawToolExposure: false,
      writerEnabled: false
    }
  });
}
