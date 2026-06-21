import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

import { loadOrCreateConfig } from '../../config/config-loader.js';
import { readRefreshFailure } from '../../state/refresh-failure.js';
import { inspectRefreshLock } from '../../state/refresh-lock.js';
import { readIndexCoverage, readLatestRevision, type IndexCoverage } from '../../state/refresh-revision.js';
import { resolveNoemaLoomPaths } from '../../state/paths.js';
import { readWorksetManifest } from '../../state/workset.js';
import { detectProjectBoundaryWarnings } from '../../projects/boundary-warnings.js';
import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type NoemaLoomEnvelope } from '../envelope.js';
import { anchorStatusData } from './nl-anchor.js';

export const nlStatusInputSchema = z
  .object({
    projectPath: z.string().optional(),
    includeRepositoryMap: z.boolean().default(false),
    includeAnchors: z.boolean().default(false),
    includeRetiredAnchors: z.boolean().default(false),
    includeAnchorText: z.boolean().default(true)
  })
  .passthrough();

type IndexState = 'missing' | 'ready' | 'stale' | 'error';

type Statement = {
  get: (...params: unknown[]) => unknown;
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

async function filePresent(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function fileSize(targetPath: string): Promise<number | undefined> {
  try {
    return (await stat(targetPath)).size;
  } catch {
    return undefined;
  }
}

async function readJson(targetPath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(targetPath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function countInventoryFiles(targetPath: string): Promise<{ state: IndexState; files: number; warning?: EnvelopeWarning }> {
  if (!(await filePresent(targetPath))) {
    return { state: 'missing', files: 0 };
  }
  const parsed = await readJson(targetPath);
  const files = parsed && typeof parsed === 'object' && 'files' in parsed && Array.isArray((parsed as { files?: unknown }).files)
    ? (parsed as { files: unknown[] }).files.length
    : undefined;
  if (files === undefined) {
    return {
      state: 'error',
      files: 0,
      warning: { code: 'file_inventory_unreadable', severity: 'error', message: `${targetPath} is not a readable inventory snapshot.` }
    };
  }
  return { state: 'ready', files };
}

async function countJsonArray(targetPath: string, code: string): Promise<{ state: IndexState; count: number; warning?: EnvelopeWarning }> {
  if (!(await filePresent(targetPath))) {
    return { state: 'missing', count: 0 };
  }
  const parsed = await readJson(targetPath);
  if (!Array.isArray(parsed)) {
    return {
      state: 'error',
      count: 0,
      warning: { code, severity: 'error', message: `${targetPath} is not a readable JSON array.` }
    };
  }
  return { state: 'ready', count: parsed.length };
}

async function countDocumentIndex(targetPath: string): Promise<{ state: IndexState; blocks: number; parseErrors: number; warning?: EnvelopeWarning }> {
  if (!(await filePresent(targetPath))) {
    return { state: 'missing', blocks: 0, parseErrors: 0 };
  }
  const parsed = await readJson(targetPath);
  if (!parsed || typeof parsed !== 'object') {
    return {
      state: 'error',
      blocks: 0,
      parseErrors: 0,
      warning: { code: 'document_index_unreadable', severity: 'error', message: `${targetPath} is not readable JSON.` }
    };
  }
  const anchors = Array.isArray((parsed as { anchors?: unknown }).anchors) ? (parsed as { anchors: unknown[] }).anchors.length : 0;
  const warnings = Array.isArray((parsed as { warnings?: unknown }).warnings) ? (parsed as { warnings: unknown[] }).warnings.length : 0;
  return { state: 'ready', blocks: anchors, parseErrors: warnings };
}

async function countDerivedMap(targetPath: string): Promise<{ state: IndexState; tokens: number; warning?: EnvelopeWarning }> {
  if (!(await filePresent(targetPath))) {
    return { state: 'missing', tokens: 0 };
  }
  const parsed = await readJson(targetPath);
  if (!parsed || typeof parsed !== 'object') {
    return {
      state: 'error',
      tokens: 0,
      warning: { code: 'derived_map_unreadable', severity: 'error', message: `${targetPath} is not readable JSON.` }
    };
  }
  return { state: 'ready', tokens: JSON.stringify(parsed).split(/\s+/).filter(Boolean).length };
}

async function readSqliteCounts(input: {
  targetPath: string;
  unreadableCode: string;
  queries: Record<string, string>;
}): Promise<{ state: IndexState; counts: Record<string, number>; warning?: EnvelopeWarning }> {
  const counts = Object.fromEntries(Object.keys(input.queries).map(key => [key, 0]));
  const size = await fileSize(input.targetPath);
  if (size === undefined) {
    return { state: 'missing', counts };
  }
  if (size === 0) {
    return {
      state: 'error',
      counts,
      warning: { code: input.unreadableCode, severity: 'error', message: `${input.targetPath} is empty or corrupt.` }
    };
  }

  let db: Database | undefined;
  try {
    db = openDatabase(input.targetPath);
    for (const [key, sql] of Object.entries(input.queries)) {
      const row = db.prepare(sql).get() as { value?: number } | undefined;
      counts[key] = Number(row?.value ?? 0);
    }
    return { state: 'ready', counts };
  } catch (error) {
    return {
      state: 'error',
      counts,
      warning: {
        code: input.unreadableCode,
        severity: 'error',
        message: error instanceof Error ? error.message : `${input.targetPath} is not readable.`
      }
    };
  } finally {
    db?.close();
  }
}

function collectWarnings(...items: Array<{ warning?: EnvelopeWarning }>): EnvelopeWarning[] {
  return items.flatMap(item => (item.warning ? [item.warning] : []));
}

function statusCoverage(input: {
  fileInventory: { state: IndexState; files: number };
  spanIndex: { state: IndexState; counts: Record<string, number> };
  metadata?: IndexCoverage;
}): IndexCoverage {
  if (input.metadata) {
    return {
      ...input.metadata,
      inventory: input.fileInventory.state === 'ready' ? 'full' : input.metadata.inventory,
      coldFiles: input.fileInventory.state === 'ready' && input.metadata.deepSpans === 'full' ? 0 : input.metadata.coldFiles
    };
  }
  if (input.fileInventory.state === 'ready' && input.spanIndex.state === 'missing') {
    return {
      inventory: 'full',
      deepSpans: 'none',
      hotsetRevision: null,
      hotFiles: 0,
      coldFiles: input.fileInventory.files,
      unindexedCandidateCount: input.fileInventory.files
    };
  }
  if (input.fileInventory.state === 'ready' && input.spanIndex.state === 'ready') {
    const deepSpans = input.spanIndex.counts.spans > 0 ? 'full' : 'none';
    return {
      inventory: 'full',
      deepSpans,
      hotsetRevision: null,
      hotFiles: deepSpans === 'full' ? input.fileInventory.files : 0,
      coldFiles: deepSpans === 'full' ? 0 : input.fileInventory.files,
      unindexedCandidateCount: deepSpans === 'full' ? 0 : input.fileInventory.files
    };
  }
  return {
    inventory: 'missing',
    deepSpans: 'none',
    hotsetRevision: null,
    hotFiles: 0,
    coldFiles: 0,
    unindexedCandidateCount: 0
  };
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
  const [fileInventory, spanIndex, factIndex, documentIndex, featureProjection, derivedMap, refreshLock, lastRefreshFailure, coverageMetadata, graphRevision] = await Promise.all([
    countInventoryFiles(path.join(paths.filesDir, 'inventory.json')),
    readSqliteCounts({
      targetPath: path.join(paths.spansDir, 'spans.db'),
      unreadableCode: 'span_index_unreadable',
      queries: {
        spans: 'SELECT COUNT(*) AS value FROM repo_spans',
        edges: 'SELECT COUNT(*) AS value FROM repo_edges',
        revisions: 'SELECT COUNT(*) AS value FROM refresh_revisions',
        symbols: 'SELECT COUNT(*) AS value FROM repo_symbols',
        aliases: 'SELECT COUNT(*) AS value FROM repo_symbol_aliases'
      }
    }),
    readSqliteCounts({
      targetPath: path.join(paths.factDir, 'codegraph.db'),
      unreadableCode: 'fact_index_unreadable',
      queries: {
        symbols: "SELECT COUNT(*) AS value FROM facts_nodes WHERE kind != 'code.callsite'",
        edges: 'SELECT COUNT(*) AS value FROM facts_edges'
      }
    }),
    countDocumentIndex(path.join(paths.documentsDir, 'anchor-index.json')),
    countJsonArray(path.join(paths.planningDir, 'features.json'), 'feature_projection_unreadable'),
    countDerivedMap(path.join(paths.derivedMapDir, 'repository-map.json')),
    inspectRefreshLock(projectRoot),
    readRefreshFailure(projectRoot),
    readIndexCoverage(projectRoot),
    readLatestRevision(projectRoot)
  ]);

  const warnings = [
    ...collectWarnings(fileInventory, spanIndex, factIndex, documentIndex, featureProjection, derivedMap),
    ...(await detectProjectBoundaryWarnings(projectRoot))
  ];
  if (refreshLock.state === 'stale') {
    warnings.push({
      code: 'refresh_lock_stale',
      severity: 'error',
      message: `Refresh lock belongs to dead pid ${refreshLock.pid}. A previous refresh likely aborted before cleanup.`
    });
  } else if (refreshLock.state === 'active') {
    warnings.push({
      code: 'refresh_in_progress',
      severity: 'warning',
      message: `Refresh lock is active for pid ${refreshLock.pid}.`
    });
  } else if (refreshLock.state === 'unreadable') {
    warnings.push({
      code: 'refresh_lock_unreadable',
      severity: 'error',
      message: refreshLock.message
    });
  }
  if (lastRefreshFailure) {
    warnings.push({
      code: 'refresh_last_failure',
      severity: 'error',
      message: `${lastRefreshFailure.tool}${lastRefreshFailure.target ? ` target=${lastRefreshFailure.target}` : ''} failed at ${lastRefreshFailure.failedAt}: ${lastRefreshFailure.message}`
    });
  }
  const states = [fileInventory.state, spanIndex.state, factIndex.state, documentIndex.state, featureProjection.state, derivedMap.state];
  const hasReady = states.includes('ready');
  const hasError = states.includes('error') || warnings.some(warning => warning.severity === 'error');
  const graphReady =
    fileInventory.state === 'ready' &&
    spanIndex.state === 'ready' &&
    factIndex.state === 'ready' &&
    derivedMap.state === 'ready';
  const coverage = statusCoverage({ fileInventory, spanIndex, metadata: coverageMetadata });

  const nextActions = refreshLock.state === 'stale'
    ? [
        'retry nl_refresh; stale dead-pid locks are removed automatically before refresh starts',
        'if retry cannot run, delete .noemaloom/locks/refresh.lock after confirming no NoemaLoom refresh process is active'
      ]
    : [];

  const anchorWorkset = parsed.includeAnchors
    ? anchorStatusData(await readWorksetManifest(projectRoot), parsed.includeRetiredAnchors, parsed.includeAnchorText)
    : undefined;

  return createEnvelope({
    ok: !hasError,
    tool: 'nl_status',
    projectRoot,
    graphRevision: graphRevision ?? null,
    graphState: hasError ? 'error' : graphReady ? 'ready' : hasReady ? 'partial' : 'empty',
    warnings,
    nextActions,
    data: {
      stateDir: '.noemaloom',
      fileInventory: { state: fileInventory.state, files: fileInventory.files },
      spanIndex: { state: spanIndex.state, spans: spanIndex.counts.spans, edges: spanIndex.counts.edges },
      retrievalCore: { state: spanIndex.state, symbols: spanIndex.counts.symbols, aliases: spanIndex.counts.aliases },
      coverage,
      factIndex: { state: factIndex.state, symbols: factIndex.counts.symbols, edges: factIndex.counts.edges },
      documentIndex: { state: documentIndex.state, blocks: documentIndex.blocks, parseErrors: documentIndex.parseErrors },
      artifactIndex: { state: 'missing' as const, entries: 0 },
      featureProjection: { state: featureProjection.state, features: featureProjection.count },
      derivedMap: { state: derivedMap.state, tokens: derivedMap.tokens },
      refreshLock,
      lastRefreshFailure: lastRefreshFailure ?? null,
      rawToolExposure: false,
      writerEnabled: false,
      ...(anchorWorkset ? { anchorWorkset } : {})
    }
  });
}
