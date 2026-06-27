import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

import { indexArtifactSpans, type ArtifactSpan } from '../../artifacts/artifact-span-indexer.js';
import { indexCodeFacts, type IndexCodeFactsResult } from '../../code-fact/code-fact-indexer.js';
import { readCodeGraphDb, writeCodeGraphDb, type CodeGraphSnapshot } from '../../code-fact/codegraph-db.js';
import type { CodeFactEdge } from '../../code-fact/extractor.js';
import { buildRepositoryMap, writeRepositoryMap } from '../../derived-map/repository-map.js';
import { indexDocumentSpans, type DocumentSpan } from '../../documents/document-span-indexer.js';
import { buildFileInventory, buildFileInventoryForPaths, buildFileInventoryFromSnapshot, type FileInventory, type InventoryFile } from '../../files/file-inventory.js';
import { isGitRepository, listGitChangedCandidateFiles, listGitDeletedFiles, listGitVisibleFiles } from '../../files/git-files.js';
import { projectFeatures } from '../../feature-projection/feature-projector.js';
import { buildCrossReferenceEdges } from '../../linker/cross-reference-linker.js';
import { extractLinkCandidatesFromSpans } from '../../linker/evidence-extractors.js';
import { detectCodexScientistHotsetSeedPaths, isCodexScientistColdPath } from '../../profiles/codex-scientist.js';
import { safeReadFileInsideProject, writeFileInsideStateDir } from '../../safety/path-guard.js';
import { buildProjectionGraph, type FeatureProjectionRecord } from '../../spans/projection-builder.js';
import type { RepoEdge, RepoSpan } from '../../spans/types.js';
import { indexTestExampleSpans, type TestExampleSpan } from '../../tests-examples/test-example-span-indexer.js';
import { createInventorySnapshot, detectChangedFiles, readInventorySnapshot, type ChangedFiles, type InventorySnapshot } from '../../state/changed-detection.js';
import { hotsetRevision, manifestFiles, readHotsetManifest, upsertHotsetEntries, writeHotsetManifest } from '../../state/hotset.js';
import { resolveNoemaLoomPaths } from '../../state/paths.js';
import { createGraphRevision, readIndexCoverage, readLatestRefreshSummary, readLatestRevision, readStoredGraphSnapshot, writeRefreshRevision, writeRefreshRevisionDelta, type IndexCoverage, type StoredGraphSnapshot } from '../../state/refresh-revision.js';
import { clearRefreshFailure, recordRefreshFailure, refreshFailureMessage } from '../../state/refresh-failure.js';
import { withRefreshLock } from '../../state/refresh-lock.js';
import { cleanupOldStateFiles } from '../../state/retention.js';
import { ensureStateDir } from '../../state/state-dir.js';
import { writeTransientBackup } from '../../state/transient-backup.js';
import { loadOrCreateConfig } from '../../config/config-loader.js';
import type { NoemaLoomConfig } from '../../config/default-config.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

const refreshTargets = ['all', 'changed', 'files', 'hotset', 'paths', 'code', 'docs', 'artifacts', 'tests', 'features', 'links', 'map'] as const;
const refreshModes = ['safe', 'force'] as const;

type RefreshTarget = (typeof refreshTargets)[number];
type RefreshMode = (typeof refreshModes)[number];

type Database = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
  close: () => void;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

export const nlRefreshInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.enum(refreshTargets).default('all'),
    mode: z.enum(refreshModes).default('safe'),
    paths: z.array(z.string()).default([]),
    promotionReason: z.string().optional()
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

const SCOPED_REFRESH_STEPS = [
  'FileInventory',
  'HotsetManifest',
  'CodeFactIndexer',
  'DocumentSpanIndexer',
  'ArtifactSpanIndexer',
  'TestExampleSpanIndexer',
  'ProjectionBuilder',
  'CrossReferenceLinker',
  'DerivedRepositoryMapBuilder',
  'RefreshRevisionWriter'
] as const;

const FILE_REFRESH_STEPS = ['FileInventory'] as const;
const CHANGED_DEEP_REFRESH_STEPS = [
  'FileInventory',
  'CodeFactIndexer',
  'DocumentSpanIndexer',
  'ArtifactSpanIndexer',
  'TestExampleSpanIndexer',
  'ProjectionBuilder',
  'CrossReferenceLinker',
  'DerivedRepositoryMapBuilder',
  'RefreshRevisionWriter'
] as const;
const CHANGED_NOOP_REFRESH_STEPS = ['FileInventory', 'ChangedNoopFastPath'] as const;
const CHANGED_DELTA_REFRESH_STEPS = [
  'FileInventory',
  'ChangedDeltaStateReader',
  'ScopeSelection',
  'CodeFactIndexer',
  'DocumentSpanIndexer',
  'ArtifactSpanIndexer',
  'TestExampleSpanIndexer',
  'ProjectionBuilder',
  'CodeGraphDeltaWriter',
  'ChangedDeltaGraphMerger',
  'DerivedRepositoryMapBuilder',
  'DerivedRepositoryMapWriter',
  'InventoryWriter',
  'DocumentAnchorIndexWriter',
  'ChangedDeltaRevisionWriter'
] as const;
const MAX_QUARANTINED_SQLITE_FILES = 5;

function isDocument(file: InventoryFile, scoped: boolean): boolean {
  if (!['markdown', 'mdx', 'rst'].includes(file.language)) {
    return false;
  }
  if (['generated_file', 'vendor_file'].includes(file.role)) {
    return false;
  }
  return scoped || file.role !== 'experiment_note_doc';
}

function isArtifact(file: InventoryFile, scoped: boolean): boolean {
  if (!['json', 'yaml', 'toml'].includes(file.language)) {
    return false;
  }
  if (['generated_file', 'vendor_file'].includes(file.role)) {
    return false;
  }
  return scoped || file.role !== 'experiment_note_doc';
}

function isTestExampleCandidate(file: InventoryFile, scoped: boolean): boolean {
  if (['generated_file', 'vendor_file'].includes(file.role)) {
    return false;
  }
  if (!scoped && file.role === 'experiment_note_doc') {
    return false;
  }
  return ['python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin', 'scala'].includes(file.language) || /(^|\/)examples?\//.test(file.path);
}

type TextProvider = (file: InventoryFile) => Promise<string>;

const REFRESH_INDEX_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function createTextProvider(projectRoot: string): TextProvider {
  const cache = new Map<string, Promise<string>>();
  return (file: InventoryFile): Promise<string> => {
    if (file.oversized) {
      return Promise.resolve('');
    }
    if (file.indexedText !== '' || file.sizeBytes === 0) {
      return Promise.resolve(file.indexedText);
    }
    const cached = cache.get(file.path);
    if (cached) {
      return cached;
    }
    const text = safeReadFileInsideProject(projectRoot, file.path, 'utf8');
    cache.set(file.path, text);
    return text;
  };
}

async function indexDocumentFiles(projectRoot: string, files: InventoryFile[], textForFile: TextProvider): Promise<{ spans: DocumentSpan[]; warnings: string[] }> {
  const results = await mapWithConcurrency(files, REFRESH_INDEX_CONCURRENCY, async file => {
    const result = await indexDocumentSpans({
      projectRoot,
      path: file.path,
      text: await textForFile(file)
    });
    return {
      spans: result.spans,
      warnings: result.warnings.map(warning => `${result.path}: ${warning.message}`)
    };
  });
  return {
    spans: results.flatMap(result => result.spans),
    warnings: results.flatMap(result => result.warnings)
  };
}

async function indexArtifactFiles(files: InventoryFile[], textForFile: TextProvider): Promise<{ spans: ArtifactSpan[]; warnings: string[] }> {
  const results = await mapWithConcurrency(files, REFRESH_INDEX_CONCURRENCY, async file => {
    const result = indexArtifactSpans({ path: file.path, text: await textForFile(file) });
    return {
      spans: result.spans,
      warnings: result.warnings.map(warning => `${result.path}: ${warning}`)
    };
  });
  return {
    spans: results.flatMap(result => result.spans),
    warnings: results.flatMap(result => result.warnings)
  };
}

async function indexTestExampleFiles(files: InventoryFile[], textForFile: TextProvider): Promise<TestExampleSpan[]> {
  const spanGroups = await mapWithConcurrency(files, REFRESH_INDEX_CONCURRENCY, async file =>
    indexTestExampleSpans({ path: file.path, text: await textForFile(file) }).spans
  );
  return spanGroups.flat();
}

type FeatureProjectionLocation = {
  stateDir: string;
  featuresFile: string;
  featurePath: string;
};

function featureProjectionLocation(projectRoot: string, config: NoemaLoomConfig): FeatureProjectionLocation {
  const stateDir = resolveFeatureProjectionStateDir(projectRoot, config.featureProjection.stateDir);
  const featuresFile = path.join(stateDir, 'planning', 'features.json');
  const relative = path.relative(path.resolve(projectRoot), featuresFile).replaceAll('\\', '/');
  const featurePath = relative && !relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative)
    ? relative
    : '.noemaloom/planning/features.json';
  return { stateDir, featuresFile, featurePath };
}

async function readFeatures(projectRoot: string, config: NoemaLoomConfig): Promise<FeatureProjectionRecord[]> {
  const location = featureProjectionLocation(projectRoot, config);
  try {
    const parsed = JSON.parse(await readFile(location.featuresFile, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(item => item && typeof item === 'object')
      .map(item => item as Record<string, unknown>)
      .map(item => ({
        id: String(item.id ?? item.title ?? 'feature.unknown'),
        title: String(item.title ?? item.id ?? 'Untitled feature'),
        source: String(item.source ?? 'feature-projection'),
        featurePath: location.featurePath
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

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  return [...new Map(items.map(item => [keyFor(item), item])).values()];
}

type ChangedDeltaBase = {
  graph: StoredGraphSnapshot;
  codeGraph: CodeGraphSnapshot;
};

function touchedPathSet(changed: ChangedFiles): Set<string> {
  return new Set([...changed.changedPaths, ...changed.deletedPaths]);
}

async function readChangedDeltaBase(input: {
  projectRoot: string;
  target: RefreshTarget;
  coverage?: IndexCoverage;
  inventory: FileInventory;
  changed: ChangedFiles;
}): Promise<ChangedDeltaBase | undefined> {
  if (
    input.target !== 'changed' ||
    input.coverage?.deepSpans !== 'full' ||
    input.inventory.strategy?.source !== 'snapshot_plus_git_changed' ||
    (input.changed.changedPaths.length === 0 && input.changed.deletedPaths.length === 0)
  ) {
    return undefined;
  }
  const [graph, codeGraph] = await Promise.all([
    readStoredGraphSnapshot(input.projectRoot),
    readCodeGraphDb(input.projectRoot)
  ]);
  return graph && codeGraph ? { graph, codeGraph } : undefined;
}

function mergeCodeGraphDelta(input: {
  base: CodeGraphSnapshot;
  changed: ChangedFiles;
  changedCodeFacts: IndexCodeFactsResult;
  changedFiles: InventoryFile[];
}): CodeGraphSnapshot {
  const touched = touchedPathSet(input.changed);
  const changedCodePaths = new Set(input.changedCodeFacts.spans.map(span => span.path));
  const filesByPath = new Map(input.base.files.filter(file => !touched.has(file.path)).map(file => [file.path, file]));
  for (const file of input.changedFiles) {
    if (changedCodePaths.has(file.path)) {
      filesByPath.set(file.path, { path: file.path, language: file.language });
    }
  }
  const spans = uniqueBy([
    ...input.base.spans.filter(span => !touched.has(span.path)),
    ...input.changedCodeFacts.spans
  ], span => span.spanId);
  const spanPathById = new Map(spans.map(span => [span.spanId, span.path]));
  const edges = uniqueBy([
    ...input.base.edges.filter(edge => {
      const sourcePath = spanPathById.get(edge.sourceSpanId);
      const targetPath = spanPathById.get(edge.targetSpanId);
      return Boolean(sourcePath && targetPath && !touched.has(sourcePath) && !touched.has(targetPath));
    }),
    ...input.changedCodeFacts.edges
  ], edge => edge.edgeId).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  return {
    files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    spans,
    edges
  };
}

function mergeStoredGraphDelta(input: {
  base: StoredGraphSnapshot;
  changed: ChangedFiles;
  changedProjectionSpans: RepoSpan[];
  changedProjectionEdges: RepoEdge[];
  codeEdges: CodeFactEdge[];
}): { spans: RepoSpan[]; edges: RepoEdge[] } {
  const touched = touchedPathSet(input.changed);
  const spans = uniqueBy([
    ...input.base.spans.filter(span => !touched.has(span.path)),
    ...input.changedProjectionSpans
  ], span => span.spanId).sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.spanId.localeCompare(right.spanId));
  const spanIds = new Set(spans.map(span => span.spanId));
  const preservedEdges = input.base.edges.filter(edge =>
    edge.source !== 'cross-reference-linker' &&
    edge.source !== 'code-fact-indexer' &&
    spanIds.has(edge.sourceSpanId) &&
    spanIds.has(edge.targetSpanId)
  );
  const xrefEdges = buildCrossReferenceEdges(extractLinkCandidatesFromSpans(spans));
  return {
    spans,
    edges: uniqueEdges([
      ...preservedEdges,
      ...input.changedProjectionEdges,
      ...input.codeEdges.map(codeEdgeToRepoEdge),
      ...xrefEdges
    ])
  };
}

function documentAnchorsFromRepoSpans(spans: RepoSpan[]): DocumentSpan[] {
  return spans
    .filter((span): span is RepoSpan & { kind: Extract<RepoSpan['kind'], `doc.${string}`> } => span.kind.startsWith('doc.'))
    .map(span => ({
      kind: span.kind,
      path: span.path,
      label: span.label,
      startLine: span.startLine,
      endLine: span.endLine,
      headingPath: span.headingPath,
      anchor: span.anchor,
      text: span.indexedText,
      metadata: span.metadata
    }));
}

async function writeInventoryOutputs(projectRoot: string, inventory: FileInventory): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  const snapshot = createInventorySnapshot(inventory);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.filesDir, 'inventory.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await unlinkIfExists(path.join(paths.filesDir, 'inventory.sqlite'));
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function unlinkIfExists(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function statIfExists(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function quarantineName(targetPath: string, stateDir: string): string {
  const relative = path.relative(stateDir, targetPath).replaceAll('\\', '/');
  return relative.replace(/[^A-Za-z0-9._/-]+/g, '_').replaceAll('/', '__');
}

async function sqliteLooksCorrupt(targetPath: string): Promise<boolean> {
  const existing = await statIfExists(targetPath);
  if (!existing?.isFile()) {
    return false;
  }
  if (existing.size === 0) {
    return true;
  }
  let db: Database | undefined;
  try {
    db = openDatabase(targetPath);
    db.prepare('PRAGMA schema_version').get();
    return false;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

async function quarantineIfExists(input: { projectRoot: string; targetPath: string; quarantineDir: string }): Promise<string | undefined> {
  const existing = await statIfExists(input.targetPath);
  if (!existing?.isFile()) {
    return undefined;
  }
  await mkdir(input.quarantineDir, { recursive: true });
  const paths = resolveNoemaLoomPaths(input.projectRoot);
  const destination = path.join(input.quarantineDir, `${Date.now()}-${process.pid}-${quarantineName(input.targetPath, paths.stateDir)}`);
  await rename(input.targetPath, destination);
  return destination;
}

async function quarantineCorruptSqliteGroup(input: { projectRoot: string; targetPath: string }): Promise<string[]> {
  if (!(await sqliteLooksCorrupt(input.targetPath))) {
    return [];
  }
  const paths = resolveNoemaLoomPaths(input.projectRoot);
  const quarantineDir = path.join(paths.transientDir, 'quarantine');
  const moved: string[] = [];
  for (const candidate of [input.targetPath, `${input.targetPath}-journal`, `${input.targetPath}-wal`, `${input.targetPath}-shm`]) {
    const destination = await quarantineIfExists({ projectRoot: input.projectRoot, targetPath: candidate, quarantineDir });
    if (destination) {
      moved.push(destination);
    }
  }
  if (moved.length > 0) {
    await cleanupOldStateFiles({
      projectRoot: input.projectRoot,
      directory: quarantineDir,
      keepNewest: MAX_QUARANTINED_SQLITE_FILES,
      match: () => true
    });
  }
  return moved;
}

async function removeDeepIndexOutputs(projectRoot: string): Promise<string[]> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const warnings: string[] = [];
  for (const targetPath of [path.join(paths.spansDir, 'spans.db'), path.join(paths.factDir, 'codegraph.db')]) {
    const quarantined = await quarantineCorruptSqliteGroup({ projectRoot, targetPath });
    if (quarantined.length > 0) {
      warnings.push(`${path.relative(paths.stateDir, targetPath).replaceAll('\\', '/')}: corrupt sqlite evidence moved to transient/quarantine (${quarantined.length} files)`);
    }
  }
  for (const targetPath of [
    path.join(paths.spansDir, 'spans.db'),
    path.join(paths.spansDir, 'spans.db-journal'),
    path.join(paths.spansDir, 'spans.db-wal'),
    path.join(paths.spansDir, 'spans.db-shm'),
    path.join(paths.factDir, 'codegraph.db'),
    path.join(paths.factDir, 'codegraph.db-journal'),
    path.join(paths.factDir, 'codegraph.db-wal'),
    path.join(paths.factDir, 'codegraph.db-shm'),
    path.join(paths.documentsDir, 'anchor-index.json'),
    path.join(paths.derivedMapDir, 'repository-map.json'),
    path.join(paths.derivedMapDir, 'repository-map.md')
  ]) {
    await unlinkIfExists(targetPath);
  }
  return warnings;
}

const DEFAULT_FEATURE_WORKER_COMMANDS = new Set([
  'python -m nl_rpg_projection_worker.main',
  'python3 -m nl_rpg_projection_worker.main'
]);

function resolveFeatureProjectionStateDir(projectRoot: string, configuredStateDir: string): string {
  const absolute = path.isAbsolute(configuredStateDir)
    ? path.resolve(configuredStateDir)
    : path.resolve(projectRoot, configuredStateDir);
  return path.basename(absolute) === 'planning' ? path.dirname(absolute) : absolute;
}

async function runFeatureProjection(projectRoot: string, graphRevision: string, config: NoemaLoomConfig): Promise<string[]> {
  const workerCommand = config.featureProjection.workerCommand.trim();
  const usesDefaultWorker = DEFAULT_FEATURE_WORKER_COMMANDS.has(workerCommand);
  const location = featureProjectionLocation(projectRoot, config);
  const result = await projectFeatures({
    command: 'feature.project_from_repo',
    projectRoot,
    stateDir: location.stateDir,
    revision: graphRevision,
    pythonExecutable: usesDefaultWorker ? process.env.PYTHON ?? 'python3' : undefined,
    workerCommand: usesDefaultWorker ? undefined : workerCommand,
    pythonPath: process.env.NOEMALOOM_PYTHONPATH,
    timeoutMs: config.featureProjection.timeoutMs,
    maxOutputBytes: config.featureProjection.maxOutputBytes
  });
  return result.state === 'available' ? [] : result.warnings.map(warning => `featureProjection: ${warning}`);
}

function isFullTarget(target: RefreshTarget): boolean {
  return !['files', 'hotset', 'paths'].includes(target);
}

function normalizeRepoPath(projectRoot: string, requestedPath: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const absolute = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, absolute).replaceAll('\\', '/');
  if (relative === '' || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`hotset path escapes project root: ${requestedPath}`);
  }
  return relative;
}

function resolveRequestedFiles(projectRoot: string, inventory: FileInventory, requestedPaths: string[]): InventoryFile[] {
  if (requestedPaths.length === 0) {
    throw new Error('target="paths" requires a non-empty paths array');
  }
  const byPath = new Map(inventory.files.map(file => [file.path, file]));
  const selected = new Map<string, InventoryFile>();
  for (const requestedPath of requestedPaths) {
    const repoPath = normalizeRepoPath(projectRoot, requestedPath);
    const file = byPath.get(repoPath);
    if (!file) {
      throw new Error(`hotset path is not in the current file inventory: ${requestedPath}`);
    }
    selected.set(file.path, file);
  }
  return [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function tryBuildScopedSnapshotInventory(input: {
  projectRoot: string;
  target: RefreshTarget;
  requestedPaths: string[];
  config: NoemaLoomConfig;
  previousInventory?: InventorySnapshot;
}): Promise<FileInventory | undefined> {
  if (!input.previousInventory || !['paths', 'hotset'].includes(input.target)) {
    return undefined;
  }

  if (input.target === 'paths' && input.requestedPaths.length === 0) {
    return undefined;
  }

  const source = input.target === 'paths' ? 'snapshot_plus_requested_paths' as const : 'snapshot_plus_hotset' as const;
  const snapshotInventory = buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    source
  });
  const seedPaths = await detectCodexScientistHotsetSeedPaths(input.projectRoot, snapshotInventory.files);
  const manifest = input.target === 'hotset' ? await readHotsetManifest(input.projectRoot) : undefined;
  const manifestPaths = manifest?.entries.map(entry => entry.path) ?? [];

  const requiredInventory = input.target === 'paths'
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: input.requestedPaths,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: false
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };
  const requiredPaths = new Set(requiredInventory.files.map(file => file.path));
  const optionalPaths = uniqueStrings([...manifestPaths, ...seedPaths].filter(repoPath => !requiredPaths.has(normalizeRepoPath(input.projectRoot, repoPath))));
  const optionalInventory = optionalPaths.length > 0
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: optionalPaths,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: true
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };

  return buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    refreshedFiles: [...requiredInventory.files, ...optionalInventory.files],
    ignoredPaths: [...requiredInventory.ignoredPaths, ...optionalInventory.ignoredPaths],
    source
  });
}

async function tryBuildChangedSnapshotInventory(input: {
  projectRoot: string;
  config: NoemaLoomConfig;
  previousInventory?: InventorySnapshot;
}): Promise<FileInventory | undefined> {
  if (!input.previousInventory || !(await isGitRepository(input.projectRoot))) {
    return undefined;
  }
  const [visibleFiles, changedCandidates, gitDeletedFiles] = await Promise.all([
    listGitVisibleFiles(input.projectRoot),
    listGitChangedCandidateFiles(input.projectRoot),
    listGitDeletedFiles(input.projectRoot)
  ]);
  const visible = new Set(visibleFiles.map(repoPath => normalizeRepoPath(input.projectRoot, repoPath)));
  for (const deletedPath of gitDeletedFiles) {
    visible.delete(normalizeRepoPath(input.projectRoot, deletedPath));
  }
  const deletedPaths = input.previousInventory.files
    .map(file => normalizeRepoPath(input.projectRoot, file.path))
    .filter(repoPath => !visible.has(repoPath));
  const refreshedInventory = changedCandidates.length > 0
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: changedCandidates,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: true
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };

  return buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    refreshedFiles: refreshedInventory.files,
    deletedPaths,
    ignoredPaths: refreshedInventory.ignoredPaths,
    source: 'snapshot_plus_git_changed'
  });
}

type ScopeSelection = {
  scoped: boolean;
  deepFiles: InventoryFile[];
  coverage: IndexCoverage;
  hotsetRevision: string | null;
  warnings: string[];
  changedTargetStrategy?: 'scoped_hotset_reindex' | 'full_deep_reindex' | 'git_delta_reindex';
};

type RefreshTiming = {
  step: string;
  durationMs: number;
};

type DeepIndexReport = {
  scope: 'none' | 'scoped' | 'full';
  deepFiles: number;
  hotFiles: number;
  coldFiles: number;
  changedTargetStrategy?: 'scoped_hotset_reindex' | 'full_deep_reindex' | 'no_change_fast_path' | 'git_delta_reindex';
};

async function timed<T>(timings: RefreshTiming[], step: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    timings.push({ step, durationMs: Date.now() - startedAt });
  }
}

function timedSync<T>(timings: RefreshTiming[], step: string, task: () => T): T {
  const startedAt = Date.now();
  try {
    return task();
  } finally {
    timings.push({ step, durationMs: Date.now() - startedAt });
  }
}

function deepIndexReport(target: RefreshTarget, selection: ScopeSelection): DeepIndexReport {
  const scope = selection.coverage.deepSpans === 'none' ? 'none' : selection.scoped ? 'scoped' : 'full';
  return {
    scope,
    deepFiles: selection.deepFiles.length,
    hotFiles: selection.coverage.hotFiles,
    coldFiles: selection.coverage.coldFiles,
    ...(target === 'changed'
      ? { changedTargetStrategy: selection.changedTargetStrategy ?? (selection.scoped ? 'scoped_hotset_reindex' as const : 'full_deep_reindex' as const) }
      : {})
  };
}

function deepIndexReportFromCoverage(target: RefreshTarget, coverage: IndexCoverage, fileCount: number): DeepIndexReport {
  const scoped = coverage.deepSpans === 'scoped';
  const scope = coverage.deepSpans === 'none' ? 'none' : scoped ? 'scoped' : 'full';
  const deepFiles = coverage.deepSpans === 'none' ? 0 : scoped ? coverage.hotFiles : fileCount;
  return {
    scope,
    deepFiles,
    hotFiles: coverage.hotFiles,
    coldFiles: coverage.coldFiles,
    ...(target === 'changed' ? { changedTargetStrategy: 'no_change_fast_path' as const } : {})
  };
}

async function selectDeepFiles(input: {
  projectRoot: string;
  target: RefreshTarget;
  inventory: FileInventory;
  requestedPaths: string[];
  promotionReason?: string;
  previousCoverage?: IndexCoverage;
  changed?: ChangedFiles;
  allowChangedDelta?: boolean;
}): Promise<ScopeSelection> {
  const now = Date.now();
  if (input.target === 'files') {
    return {
      scoped: false,
      deepFiles: [],
      hotsetRevision: null,
      warnings: [],
      coverage: {
        inventory: 'full',
        deepSpans: 'none',
        hotsetRevision: null,
        hotFiles: 0,
        coldFiles: input.inventory.files.length,
        unindexedCandidateCount: input.inventory.files.length,
        updatedAt: now
      }
    };
  }

  if (
    input.target === 'changed' &&
    input.allowChangedDelta &&
    input.previousCoverage?.deepSpans === 'full' &&
    input.inventory.strategy?.source === 'snapshot_plus_git_changed' &&
    input.changed &&
    (input.changed.changedPaths.length > 0 || input.changed.deletedPaths.length > 0)
  ) {
    const changedPathSet = new Set(input.changed.changedPaths);
    const deepFiles = input.inventory.files
      .filter(file => changedPathSet.has(file.path) && !file.oversized)
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      scoped: false,
      deepFiles,
      hotsetRevision: null,
      warnings: input.inventory.files
        .filter(file => changedPathSet.has(file.path) && file.oversized)
        .map(file => `${file.path}: oversized changed file kept file-only; no deep spans emitted`),
      changedTargetStrategy: 'git_delta_reindex',
      coverage: {
        inventory: 'full',
        deepSpans: 'full',
        hotsetRevision: null,
        hotFiles: input.inventory.files.length,
        coldFiles: 0,
        unindexedCandidateCount: 0,
        updatedAt: now
      }
    };
  }

  if (input.target === 'paths' || input.target === 'hotset' || (input.target === 'changed' && input.previousCoverage?.deepSpans === 'scoped')) {
    const manifest = await readHotsetManifest(input.projectRoot);
    const seedPaths = await detectCodexScientistHotsetSeedPaths(input.projectRoot, input.inventory.files);
    const byPath = new Map(input.inventory.files.map(file => [file.path, file]));
    const seedFiles = seedPaths.map(repoPath => byPath.get(repoPath)).filter((file): file is InventoryFile => Boolean(file));
    let nextManifest = manifest;

    if (input.target === 'paths') {
      const requested = resolveRequestedFiles(input.projectRoot, input.inventory, input.requestedPaths);
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: requested,
        reason: input.promotionReason ?? 'explicit_paths',
        pinned: true
      });
    }

    if (seedFiles.length > 0) {
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: seedFiles,
        reason: 'codex_scientist_seed',
        pinned: false
      });
    }

    const currentManifestFiles = manifestFiles(nextManifest, input.inventory.files);
    if (input.target === 'changed' && currentManifestFiles.length > 0) {
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: currentManifestFiles,
        reason: 'changed_hotset_refresh'
      });
    }

    await writeHotsetManifest(input.projectRoot, nextManifest);
    const entryByPath = new Map(nextManifest.entries.map(entry => [entry.path, entry]));
    const manifestHotFiles = manifestFiles(nextManifest, input.inventory.files);
    const skippedColdDefaults = manifestHotFiles.filter(file => isCodexScientistColdPath(file.path) && !entryByPath.get(file.path)?.pinned);
    const allHotFiles = manifestHotFiles.filter(file => !isCodexScientistColdPath(file.path) || Boolean(entryByPath.get(file.path)?.pinned));
    const deepFiles = allHotFiles.filter(file => !file.oversized).sort((left, right) => left.path.localeCompare(right.path));
    const revision = hotsetRevision(nextManifest);
    const hotPaths = new Set(allHotFiles.map(file => file.path));
    const warnings = [
      ...skippedColdDefaults.map(file => `${file.path}: cold-pattern file remains file-inventory only; use target=\"paths\" to explicitly promote`),
      ...allHotFiles
        .filter(file => file.oversized)
        .map(file => `${file.path}: oversized hotset file kept file-only; no deep spans emitted`)
    ];

    return {
      scoped: true,
      deepFiles,
      hotsetRevision: revision,
      warnings,
      coverage: {
        inventory: 'full',
        deepSpans: 'scoped',
        hotsetRevision: revision,
        hotFiles: hotPaths.size,
        coldFiles: input.inventory.files.length - hotPaths.size,
        unindexedCandidateCount: input.inventory.files.length - hotPaths.size,
        updatedAt: now
      }
    };
  }

  return {
    scoped: false,
    deepFiles: input.inventory.files,
    hotsetRevision: null,
    warnings: [],
    coverage: {
      inventory: 'full',
      deepSpans: 'full',
      hotsetRevision: null,
      hotFiles: input.inventory.files.length,
      coldFiles: 0,
      unindexedCandidateCount: 0,
      updatedAt: now
    }
  };
}

async function runRefresh(input: {
  projectRoot: string;
  target: RefreshTarget;
  mode: RefreshMode;
  paths: string[];
  promotionReason?: string;
  config: NoemaLoomConfig;
}) {
  const startedAt = Date.now();
  const timings: RefreshTiming[] = [];
  const refreshNonce = `${startedAt}:${process.hrtime.bigint().toString()}`;
  const previousInventory = await readInventorySnapshot(input.projectRoot);
  const previousCoverage = await readIndexCoverage(input.projectRoot);
  if (input.mode === 'force') {
    await writeTransientBackup({
      projectRoot: input.projectRoot,
      previousRevision: await readLatestRevision(input.projectRoot),
      target: input.target
    });
  }

  const inventory = await timed(timings, 'FileInventory', async () =>
    (input.target === 'changed'
      ? await tryBuildChangedSnapshotInventory({
          projectRoot: input.projectRoot,
          config: input.config,
          previousInventory
        })
      : await tryBuildScopedSnapshotInventory({
          projectRoot: input.projectRoot,
          target: input.target,
          requestedPaths: input.paths,
          config: input.config,
          previousInventory
        })) ?? buildFileInventory({ projectRoot: input.projectRoot, config: input.config, loadIndexedText: false, previousFiles: previousInventory?.files })
  );
  const changed = detectChangedFiles(previousInventory, inventory.files);
  if (
    input.target === 'changed' &&
    input.mode === 'safe' &&
    previousInventory &&
    previousCoverage &&
    changed.changedPaths.length === 0 &&
    changed.deletedPaths.length === 0
  ) {
    const latestSummary = await timed(timings, 'LatestRefreshSummaryReader', () => readLatestRefreshSummary(input.projectRoot));
    if (latestSummary && latestSummary.fileCount === inventory.files.length) {
      return {
        status: 'unchanged',
        target: input.target,
        mode: input.mode,
        graphRevision: latestSummary.graphRevision,
        graphState: 'ready' as const,
        steps: [...CHANGED_NOOP_REFRESH_STEPS],
        changed,
        coverage: previousCoverage,
        deepIndex: deepIndexReportFromCoverage(input.target, previousCoverage, latestSummary.fileCount),
        inventoryStrategy: inventory.strategy,
        durationMs: Date.now() - startedAt,
        timings,
        counts: {
          files: latestSummary.fileCount,
          hotFiles: previousCoverage.hotFiles,
          coldFiles: previousCoverage.coldFiles,
          spans: latestSummary.spanCount,
          edges: latestSummary.edgeCount,
          warnings: latestSummary.warnings.length
        },
        warnings: latestSummary.warnings
      };
    }
  }
  const changedDeltaBase = await timed(timings, 'ChangedDeltaStateReader', () => readChangedDeltaBase({
    projectRoot: input.projectRoot,
    target: input.target,
    coverage: previousCoverage,
    inventory,
    changed
  }));
  const selection = await timed(timings, 'ScopeSelection', () => selectDeepFiles({
    projectRoot: input.projectRoot,
    target: input.target,
    inventory,
    requestedPaths: input.paths,
    promotionReason: input.promotionReason,
    previousCoverage,
    changed,
    allowChangedDelta: Boolean(changedDeltaBase)
  }));

  if (input.target === 'files') {
    await writeInventoryOutputs(input.projectRoot, inventory);
    const cleanupWarnings = await removeDeepIndexOutputs(input.projectRoot);
    return {
      status: 'refreshed',
      target: input.target,
      mode: input.mode,
      graphRevision: null,
      graphState: 'partial' as const,
      steps: [...FILE_REFRESH_STEPS],
      coverage: selection.coverage,
      deepIndex: deepIndexReport(input.target, selection),
      inventoryStrategy: inventory.strategy,
      durationMs: Date.now() - startedAt,
      timings,
      counts: {
        files: inventory.files.length,
        spans: 0,
        edges: 0,
        warnings: cleanupWarnings.length
      },
      warnings: cleanupWarnings,
      changed: undefined
    };
  }

  const deepInventory: FileInventory = { files: selection.deepFiles, ignoredPaths: inventory.ignoredPaths };
  const textForFile = createTextProvider(input.projectRoot);
  const isChangedDelta = selection.changedTargetStrategy === 'git_delta_reindex' && Boolean(changedDeltaBase);
  const codeFacts = await timed(timings, 'CodeFactIndexer', () => indexCodeFacts({
    projectRoot: input.projectRoot,
    inventory: deepInventory,
    includeExperimentNotes: selection.scoped,
    includeVendor: selection.scoped,
    textForFile,
    writeDb: !isChangedDelta
  }));
  const [documentIndexed, artifactIndexed, testExampleSpans] = await Promise.all([
    timed(timings, 'DocumentSpanIndexer', () => indexDocumentFiles(input.projectRoot, selection.deepFiles.filter(file => !file.oversized && isDocument(file, selection.scoped)), textForFile)),
    timed(timings, 'ArtifactSpanIndexer', () => indexArtifactFiles(selection.deepFiles.filter(file => !file.oversized && isArtifact(file, selection.scoped)), textForFile)),
    timed(timings, 'TestExampleSpanIndexer', () => indexTestExampleFiles(selection.deepFiles.filter(file => !file.oversized && isTestExampleCandidate(file, selection.scoped)), textForFile))
  ]);
  const documentSpans = documentIndexed.spans;
  const documentWarnings = documentIndexed.warnings;
  const artifactSpans = artifactIndexed.spans;
  const artifactWarnings = artifactIndexed.warnings;
  const graphRevisionSeed = createGraphRevision({
    target: input.target,
    files: selection.deepFiles,
    spans: [],
    edges: [],
    nonce: `${refreshNonce}:seed`
  });
  const shouldRunFeatureProjection = input.target !== 'changed' && !selection.scoped && input.config.featureProjection.enabled;
  const shouldReadFeatureProjection = !isChangedDelta && !selection.scoped && input.config.featureProjection.enabled;
  const featureWarnings = shouldRunFeatureProjection ? await timed(timings, 'FeatureProjectionWorker', () => runFeatureProjection(input.projectRoot, graphRevisionSeed, input.config)) : [];
  const features = shouldReadFeatureProjection ? await timed(timings, 'FeatureProjectionReader', () => readFeatures(input.projectRoot, input.config)) : [];
  const projection = timedSync(timings, 'ProjectionBuilder', () => buildProjectionGraph({
    projectRoot: input.projectRoot,
    files: selection.deepFiles,
    codeSpans: codeFacts.spans,
    documentSpans,
    artifactSpans,
    testExampleSpans,
    features: selection.scoped ? [] : features
  }));

  let graphSpans = projection.spans;
  let graphEdges: RepoEdge[];
  if (isChangedDelta && changedDeltaBase) {
    const mergedCodeGraph = mergeCodeGraphDelta({
      base: changedDeltaBase.codeGraph,
      changed,
      changedCodeFacts: codeFacts,
      changedFiles: selection.deepFiles
    });
    await timed(timings, 'CodeGraphDeltaWriter', () => writeCodeGraphDb({
      projectRoot: input.projectRoot,
      files: mergedCodeGraph.files,
      spans: mergedCodeGraph.spans,
      edges: mergedCodeGraph.edges
    }));
    const merged = timedSync(timings, 'ChangedDeltaGraphMerger', () => mergeStoredGraphDelta({
      base: changedDeltaBase.graph,
      changed,
      changedProjectionSpans: projection.spans,
      changedProjectionEdges: projection.edges,
      codeEdges: mergedCodeGraph.edges
    }));
    graphSpans = merged.spans;
    graphEdges = merged.edges;
  } else {
    const xrefEdges = timedSync(timings, 'CrossReferenceLinker', () => buildCrossReferenceEdges(extractLinkCandidatesFromSpans(projection.spans)));
    graphEdges = timedSync(timings, 'EdgeDeduplicator', () => uniqueEdges([...projection.edges, ...codeFacts.edges.map(codeEdgeToRepoEdge), ...xrefEdges]));
  }

  const graphRevision = createGraphRevision({
    target: input.target,
    files: inventory.files,
    spans: graphSpans,
    edges: graphEdges,
    nonce: refreshNonce
  });
  const warnings = [...documentWarnings, ...artifactWarnings, ...featureWarnings, ...selection.warnings].sort();
  const map = timedSync(timings, 'DerivedRepositoryMapBuilder', () => buildRepositoryMap({
    projectRoot: input.projectRoot,
    graphRevision,
    spans: graphSpans,
    edges: graphEdges,
    warnings
  }));
  await timed(timings, 'DerivedRepositoryMapWriter', () => writeRepositoryMap({ projectRoot: input.projectRoot, map }));
  await timed(timings, 'InventoryWriter', () => writeInventoryOutputs(input.projectRoot, inventory));
  await timed(timings, 'DocumentAnchorIndexWriter', () => writeDocumentAnchorIndex(
    input.projectRoot,
    isChangedDelta ? documentAnchorsFromRepoSpans(graphSpans) : documentSpans,
    documentWarnings
  ));
  if (isChangedDelta) {
    await timed(timings, 'ChangedDeltaRevisionWriter', () => writeRefreshRevisionDelta({
      projectRoot: input.projectRoot,
      graphRevision,
      target: input.target,
      startedAt,
      finishedAt: Date.now(),
      files: inventory.files,
      spans: graphSpans,
      edges: graphEdges,
      warnings,
      coverage: selection.coverage,
      replacedPaths: changed.changedPaths,
      deletedPaths: changed.deletedPaths
    }));
  } else {
    await timed(timings, 'RefreshRevisionWriter', () => writeRefreshRevision({
      projectRoot: input.projectRoot,
      graphRevision,
      target: input.target,
      startedAt,
      finishedAt: Date.now(),
      files: inventory.files,
      spans: graphSpans,
      edges: graphEdges,
      warnings,
      coverage: selection.coverage
    }));
  }

  return {
    status: 'refreshed',
    target: input.target,
    mode: input.mode,
    graphRevision,
    graphState: 'ready' as const,
    steps: isChangedDelta
      ? [...CHANGED_DELTA_REFRESH_STEPS]
      : selection.scoped ? [...SCOPED_REFRESH_STEPS] : input.target === 'changed' ? [...CHANGED_DEEP_REFRESH_STEPS] : [...FULL_REFRESH_STEPS],
    changed: input.target === 'changed' ? changed : undefined,
    coverage: selection.coverage,
    deepIndex: deepIndexReport(input.target, selection),
    inventoryStrategy: inventory.strategy,
    durationMs: Date.now() - startedAt,
    timings,
    counts: {
      files: inventory.files.length,
      hotFiles: selection.coverage.hotFiles,
      coldFiles: selection.coverage.coldFiles,
      spans: graphSpans.length,
      edges: graphEdges.length,
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

  let locked: Awaited<ReturnType<typeof withRefreshLock<Awaited<ReturnType<typeof runRefresh>>>>>;
  try {
    locked = await withRefreshLock(projectRoot, () =>
      runRefresh({
        projectRoot,
        target: parsed.target,
        mode: parsed.mode,
        paths: parsed.paths,
        promotionReason: parsed.promotionReason,
        config: configResult.config
      })
    );
  } catch (error) {
    await recordRefreshFailure({
      projectRoot,
      tool: 'nl_refresh',
      target: parsed.target,
      message: refreshFailureMessage(error)
    });
    throw error;
  }

  if (!locked.ok) {
    return createEnvelope({
      ok: false,
      tool: 'nl_refresh',
      projectRoot,
      graphState: 'stale',
      data: { status: 'refresh_in_progress' }
    });
  }

  await clearRefreshFailure(projectRoot);

  return createEnvelope({
    ok: true,
    tool: 'nl_refresh',
    projectRoot,
    graphRevision: locked.result.graphRevision,
    graphState: locked.result.graphState,
    warnings: locked.result.warnings.map(warning => ({
      code: 'refresh_warning',
      severity: 'warning' as const,
      message: warning
    })),
    data: locked.result
  });
}
