import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { indexArtifactSpans, type ArtifactSpan } from '../../artifacts/artifact-span-indexer.js';
import { indexCodeFacts } from '../../code-fact/code-fact-indexer.js';
import type { CodeFactEdge } from '../../code-fact/extractor.js';
import { buildRepositoryMap, writeRepositoryMap } from '../../derived-map/repository-map.js';
import { indexDocumentSpans, type DocumentSpan } from '../../documents/document-span-indexer.js';
import { buildFileInventory, type FileInventory, type InventoryFile } from '../../files/file-inventory.js';
import { projectFeatures } from '../../feature-projection/feature-projector.js';
import { buildCrossReferenceEdges } from '../../linker/cross-reference-linker.js';
import { extractLinkCandidatesFromSpans } from '../../linker/evidence-extractors.js';
import { writeFileInsideStateDir } from '../../safety/path-guard.js';
import { buildProjectionGraph, type FeatureProjectionRecord } from '../../spans/projection-builder.js';
import type { RepoEdge } from '../../spans/types.js';
import { indexTestExampleSpans } from '../../tests-examples/test-example-span-indexer.js';
import { createInventorySnapshot, detectChangedFiles, readInventorySnapshot, type ChangedFiles } from '../../state/changed-detection.js';
import { resolveNoemaLoomPaths } from '../../state/paths.js';
import { createGraphRevision, readLatestRevision, writeRefreshRevision } from '../../state/refresh-revision.js';
import { withRefreshLock } from '../../state/refresh-lock.js';
import { ensureStateDir } from '../../state/state-dir.js';
import { writeTransientBackup } from '../../state/transient-backup.js';
import { loadOrCreateConfig } from '../../config/config-loader.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

const refreshTargets = ['all', 'changed', 'files', 'code', 'docs', 'artifacts', 'tests', 'features', 'links', 'map'] as const;
const refreshModes = ['safe', 'force'] as const;

export const nlRefreshInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.enum(refreshTargets).default('all'),
    mode: z.enum(refreshModes).default('safe')
  })
  .passthrough();

const FULL_REFRESH_STEPS = [
  'FileInventory',
  'CodeFactIndexer',
  'DocumentSpanIndexer',
  'ArtifactSpanIndexer',
  'TestExampleSpanIndexer',
  'FeatureProjectionWorker',
  'ProjectionBuilder',
  'CrossReferenceLinker',
  'DerivedRepositoryMapBuilder',
  'RefreshRevisionWriter'
] as const;

function isDocument(file: InventoryFile): boolean {
  return ['markdown', 'mdx', 'rst'].includes(file.language);
}

function isArtifact(file: InventoryFile): boolean {
  return ['json', 'yaml', 'toml'].includes(file.language);
}

async function readFeatures(projectRoot: string): Promise<FeatureProjectionRecord[]> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  try {
    const parsed = JSON.parse(await readFile(path.join(paths.planningDir, 'features.json'), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(item => item && typeof item === 'object')
      .map(item => item as Record<string, unknown>)
      .map(item => ({
        id: String(item.id ?? item.title ?? 'feature.unknown'),
        title: String(item.title ?? item.id ?? 'Untitled feature'),
        source: String(item.source ?? 'feature-projection')
      }));
  } catch {
    return [];
  }
}

function codeEdgeToRepoEdge(edge: CodeFactEdge): RepoEdge {
  return {
    edgeId: edge.edgeId,
    sourceSpanId: edge.sourceSpanId,
    targetSpanId: edge.targetSpanId,
    relation: edge.relation,
    confidence: edge.confidence,
    source: 'code-fact-indexer',
    evidence: edge.evidence,
    updatedAt: 0
  };
}

function uniqueEdges(edges: RepoEdge[]): RepoEdge[] {
  return [...new Map(edges.map(edge => [edge.edgeId, edge])).values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

async function writeInventoryOutputs(projectRoot: string, inventory: FileInventory): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  const snapshot = createInventorySnapshot(inventory);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.filesDir, 'inventory.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.filesDir, 'inventory.sqlite'), `${JSON.stringify(snapshot)}\n`);
}

async function writeDocumentAnchorIndex(projectRoot: string, spans: DocumentSpan[], warnings: string[]): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  const anchors = spans
    .filter(span => span.anchor)
    .map(span => ({ path: span.path, label: span.label, anchor: String(span.anchor), startLine: span.startLine }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.anchor.localeCompare(right.anchor));
  await writeFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.documentsDir, 'anchor-index.json'),
    `${JSON.stringify({ anchors, warnings: warnings.sort() }, null, 2)}\n`
  );
}

async function runFeatureProjection(projectRoot: string, graphRevision: string): Promise<string[]> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const result = await projectFeatures({
    command: 'feature.project_from_repo',
    projectRoot,
    stateDir: paths.stateDir,
    revision: graphRevision,
    pythonExecutable: process.env.PYTHON ?? 'python3',
    pythonPath: process.env.NOEMALOOM_PYTHONPATH
  });
  return result.state === 'available' ? [] : result.warnings.map(warning => `featureProjection: ${warning}`);
}

async function runRefresh(input: { projectRoot: string; target: (typeof refreshTargets)[number]; mode: (typeof refreshModes)[number] }) {
  const startedAt = Date.now();
  const refreshNonce = `${startedAt}:${process.hrtime.bigint().toString()}`;
  const previousInventory = await readInventorySnapshot(input.projectRoot);
  if (input.mode === 'force') {
    await writeTransientBackup({
      projectRoot: input.projectRoot,
      previousRevision: await readLatestRevision(input.projectRoot),
      target: input.target
    });
  }

  const inventory = await buildFileInventory({ projectRoot: input.projectRoot });
  const changed = detectChangedFiles(previousInventory, inventory.files);
  const codeFacts = await indexCodeFacts({ projectRoot: input.projectRoot });
  const documentResults = await Promise.all(
    inventory.files.filter(file => !file.oversized && isDocument(file)).map(file =>
      indexDocumentSpans({
        projectRoot: input.projectRoot,
        path: file.path,
        text: file.indexedText
      })
    )
  );
  const documentSpans = documentResults.flatMap(result => result.spans);
  const documentWarnings = documentResults.flatMap(result => result.warnings.map(warning => `${result.path}: ${warning.message}`));
  const artifactResults = inventory.files.filter(file => !file.oversized && isArtifact(file)).map(file => indexArtifactSpans({ path: file.path, text: file.indexedText }));
  const artifactSpans: ArtifactSpan[] = artifactResults.flatMap(result => result.spans);
  const artifactWarnings = artifactResults.flatMap(result => result.warnings.map(warning => `${result.path}: ${warning}`));
  const testExampleResults = inventory.files
    .filter(file => !file.oversized)
    .map(file => indexTestExampleSpans({ path: file.path, text: file.indexedText }));
  const testExampleSpans = testExampleResults.flatMap(result => result.spans);
  const graphRevisionSeed = createGraphRevision({
    target: input.target,
    files: inventory.files,
    spans: [],
    edges: [],
    nonce: `${refreshNonce}:seed`
  });
  const featureWarnings = await runFeatureProjection(input.projectRoot, graphRevisionSeed);
  const features = await readFeatures(input.projectRoot);
  const projection = buildProjectionGraph({
    projectRoot: input.projectRoot,
    files: inventory.files,
    codeSpans: codeFacts.spans,
    documentSpans,
    artifactSpans,
    testExampleSpans,
    features
  });
  const xrefEdges = buildCrossReferenceEdges(extractLinkCandidatesFromSpans(projection.spans));
  const edges = uniqueEdges([...projection.edges, ...codeFacts.edges.map(codeEdgeToRepoEdge), ...xrefEdges]);
  const graphRevision = createGraphRevision({
    target: input.target,
    files: inventory.files,
    spans: projection.spans,
    edges,
    nonce: refreshNonce
  });
  const warnings = [...documentWarnings, ...artifactWarnings, ...featureWarnings].sort();
  const map = buildRepositoryMap({
    projectRoot: input.projectRoot,
    graphRevision,
    spans: projection.spans,
    edges,
    warnings
  });
  await writeRepositoryMap({ projectRoot: input.projectRoot, map });
  await writeInventoryOutputs(input.projectRoot, inventory);
  await writeDocumentAnchorIndex(input.projectRoot, documentSpans, documentWarnings);
  await writeRefreshRevision({
    projectRoot: input.projectRoot,
    graphRevision,
    target: input.target,
    startedAt,
    finishedAt: Date.now(),
    files: inventory.files,
    spans: projection.spans,
    edges,
    warnings
  });

  return {
    status: 'refreshed',
    target: input.target,
    mode: input.mode,
    graphRevision,
    steps: [...FULL_REFRESH_STEPS],
    changed: input.target === 'changed' ? changed : undefined,
    counts: {
      files: inventory.files.length,
      spans: projection.spans.length,
      edges: edges.length,
      warnings: warnings.length
    },
    warnings
  };
}

export async function handleNlRefresh(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlRefreshInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const configResult = await loadOrCreateConfig(projectRoot);

  if (!configResult.ok) {
    return createEnvelope({
      ok: false,
      tool: 'nl_refresh',
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

  const locked = await withRefreshLock(projectRoot, () =>
    runRefresh({
      projectRoot,
      target: parsed.target,
      mode: parsed.mode
    })
  );

  if (!locked.ok) {
    return createEnvelope({
      ok: false,
      tool: 'nl_refresh',
      projectRoot,
      graphState: 'stale',
      data: { status: 'refresh_in_progress' }
    });
  }

  return createEnvelope({
    ok: true,
    tool: 'nl_refresh',
    projectRoot,
    graphRevision: locked.result.graphRevision,
    graphState: 'ready',
    warnings: locked.result.warnings.map(warning => ({
      code: 'refresh_warning',
      severity: 'warning' as const,
      message: warning
    })),
    data: locked.result
  });
}
