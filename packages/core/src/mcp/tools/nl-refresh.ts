import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
import { detectCodexScientistHotsetSeedPaths, isCodexScientistColdPath } from '../../profiles/codex-scientist.js';
import { writeFileInsideStateDir } from '../../safety/path-guard.js';
import { buildProjectionGraph, type FeatureProjectionRecord } from '../../spans/projection-builder.js';
import type { RepoEdge } from '../../spans/types.js';
import { indexTestExampleSpans, type TestExampleSpan } from '../../tests-examples/test-example-span-indexer.js';
import { createInventorySnapshot, detectChangedFiles, readInventorySnapshot, type ChangedFiles } from '../../state/changed-detection.js';
import { hotsetRevision, manifestFiles, readHotsetManifest, upsertHotsetEntries, writeHotsetManifest } from '../../state/hotset.js';
import { resolveNoemaLoomPaths } from '../../state/paths.js';
import { createGraphRevision, readIndexCoverage, readLatestRevision, writeRefreshRevision, type IndexCoverage } from '../../state/refresh-revision.js';
import { clearRefreshFailure, recordRefreshFailure, refreshFailureMessage } from '../../state/refresh-failure.js';
import { withRefreshLock } from '../../state/refresh-lock.js';
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

async function indexedTextForFile(file: InventoryFile): Promise<string> {
  if (file.oversized) {
    return '';
  }
  return file.indexedText || readFile(file.absolutePath, 'utf8');
}

async function indexDocumentFiles(projectRoot: string, files: InventoryFile[]): Promise<{ spans: DocumentSpan[]; warnings: string[] }> {
  const spans: DocumentSpan[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const result = await indexDocumentSpans({
      projectRoot,
      path: file.path,
      text: await indexedTextForFile(file)
    });
    spans.push(...result.spans);
    warnings.push(...result.warnings.map(warning => `${result.path}: ${warning.message}`));
  }
  return { spans, warnings };
}

async function indexArtifactFiles(files: InventoryFile[]): Promise<{ spans: ArtifactSpan[]; warnings: string[] }> {
  const spans: ArtifactSpan[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const result = indexArtifactSpans({ path: file.path, text: await indexedTextForFile(file) });
    spans.push(...result.spans);
    warnings.push(...result.warnings.map(warning => `${result.path}: ${warning}`));
  }
  return { spans, warnings };
}

async function indexTestExampleFiles(files: InventoryFile[]): Promise<TestExampleSpan[]> {
  const spans: TestExampleSpan[] = [];
  for (const file of files) {
    const result = indexTestExampleSpans({ path: file.path, text: await indexedTextForFile(file) });
    spans.push(...result.spans);
  }
  return spans;
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

type ScopeSelection = {
  scoped: boolean;
  deepFiles: InventoryFile[];
  coverage: IndexCoverage;
  hotsetRevision: string | null;
  warnings: string[];
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
  changedTargetStrategy?: 'scoped_hotset_reindex' | 'full_deep_reindex';
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
      ? { changedTargetStrategy: selection.scoped ? 'scoped_hotset_reindex' as const : 'full_deep_reindex' as const }
      : {})
  };
}

async function selectDeepFiles(input: {
  projectRoot: string;
  target: RefreshTarget;
  inventory: FileInventory;
  requestedPaths: string[];
  promotionReason?: string;
  previousCoverage?: IndexCoverage;
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

  const inventory = await timed(timings, 'FileInventory', () => buildFileInventory({ projectRoot: input.projectRoot, config: input.config, loadIndexedText: false }));
  const changed = detectChangedFiles(previousInventory, inventory.files);
  const selection = await timed(timings, 'ScopeSelection', () => selectDeepFiles({
    projectRoot: input.projectRoot,
    target: input.target,
    inventory,
    requestedPaths: input.paths,
    promotionReason: input.promotionReason,
    previousCoverage
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
  const codeFacts = await timed(timings, 'CodeFactIndexer', () => indexCodeFacts({
    projectRoot: input.projectRoot,
    inventory: deepInventory,
    includeExperimentNotes: selection.scoped,
    includeVendor: selection.scoped
  }));
  const documentIndexed = await timed(timings, 'DocumentSpanIndexer', () => indexDocumentFiles(input.projectRoot, selection.deepFiles.filter(file => !file.oversized && isDocument(file, selection.scoped))));
  const documentSpans = documentIndexed.spans;
  const documentWarnings = documentIndexed.warnings;
  const artifactIndexed = await timed(timings, 'ArtifactSpanIndexer', () => indexArtifactFiles(selection.deepFiles.filter(file => !file.oversized && isArtifact(file, selection.scoped))));
  const artifactSpans = artifactIndexed.spans;
  const artifactWarnings = artifactIndexed.warnings;
  const testExampleSpans = await timed(timings, 'TestExampleSpanIndexer', () => indexTestExampleFiles(selection.deepFiles.filter(file => !file.oversized && isTestExampleCandidate(file, selection.scoped))));
  const graphRevisionSeed = createGraphRevision({
    target: input.target,
    files: selection.deepFiles,
    spans: [],
    edges: [],
    nonce: `${refreshNonce}:seed`
  });
  const featureProjectionEnabled = !selection.scoped && input.config.featureProjection.enabled;
  const featureWarnings = featureProjectionEnabled ? await timed(timings, 'FeatureProjectionWorker', () => runFeatureProjection(input.projectRoot, graphRevisionSeed, input.config)) : [];
  const features = featureProjectionEnabled ? await timed(timings, 'FeatureProjectionReader', () => readFeatures(input.projectRoot, input.config)) : [];
  const projection = timedSync(timings, 'ProjectionBuilder', () => buildProjectionGraph({
    projectRoot: input.projectRoot,
    files: selection.deepFiles,
    codeSpans: codeFacts.spans,
    documentSpans,
    artifactSpans,
    testExampleSpans,
    features: selection.scoped ? [] : features
  }));
  const xrefEdges = timedSync(timings, 'CrossReferenceLinker', () => buildCrossReferenceEdges(extractLinkCandidatesFromSpans(projection.spans)));
  const edges = timedSync(timings, 'EdgeDeduplicator', () => uniqueEdges([...projection.edges, ...codeFacts.edges.map(codeEdgeToRepoEdge), ...xrefEdges]));
  const graphRevision = createGraphRevision({
    target: input.target,
    files: inventory.files,
    spans: projection.spans,
    edges,
    nonce: refreshNonce
  });
  const warnings = [...documentWarnings, ...artifactWarnings, ...featureWarnings, ...selection.warnings].sort();
  const map = timedSync(timings, 'DerivedRepositoryMapBuilder', () => buildRepositoryMap({
    projectRoot: input.projectRoot,
    graphRevision,
    spans: projection.spans,
    edges,
    warnings
  }));
  await timed(timings, 'DerivedRepositoryMapWriter', () => writeRepositoryMap({ projectRoot: input.projectRoot, map }));
  await timed(timings, 'InventoryWriter', () => writeInventoryOutputs(input.projectRoot, inventory));
  await timed(timings, 'DocumentAnchorIndexWriter', () => writeDocumentAnchorIndex(input.projectRoot, documentSpans, documentWarnings));
  await timed(timings, 'RefreshRevisionWriter', () => writeRefreshRevision({
    projectRoot: input.projectRoot,
    graphRevision,
    target: input.target,
    startedAt,
    finishedAt: Date.now(),
    files: inventory.files,
    spans: projection.spans,
    edges,
    warnings,
    coverage: selection.coverage
  }));

  return {
    status: 'refreshed',
    target: input.target,
    mode: input.mode,
    graphRevision,
    graphState: 'ready' as const,
    steps: selection.scoped ? [...SCOPED_REFRESH_STEPS] : [...FULL_REFRESH_STEPS],
    changed: input.target === 'changed' ? changed : undefined,
    coverage: selection.coverage,
    deepIndex: deepIndexReport(input.target, selection),
    durationMs: Date.now() - startedAt,
    timings,
    counts: {
      files: inventory.files.length,
      hotFiles: selection.coverage.hotFiles,
      coldFiles: selection.coverage.coldFiles,
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
