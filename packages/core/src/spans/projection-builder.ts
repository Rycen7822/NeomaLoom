import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ArtifactSpan } from '../artifacts/json-parser.js';
import type { CodeFactSpan } from '../code-fact/extractor.js';
import type { DocumentSpan } from '../documents/types.js';
import type { InventoryFile } from '../files/file-inventory.js';
import { languageForPath } from '../files/language.js';
import { classifyFileRole } from '../files/role-classifier.js';
import type { TestExampleSpan } from '../tests-examples/test-case-extractor.js';
import type { FileRole, SpanKind } from './enums.js';
import {
  createConfigSpanId,
  createDocumentSpanId,
  createFeatureSpanId,
  createTestExampleSpanId
} from './span-id.js';
import type { RepoEdge, RepoSpan } from './types.js';

export type FeatureProjectionRecord = {
  id: string;
  title: string;
  source: string;
};

export type ProjectionGraph = {
  spans: RepoSpan[];
  edges: RepoEdge[];
};

export type BuildProjectionGraphInput = {
  projectRoot: string;
  files: InventoryFile[];
  codeSpans: CodeFactSpan[];
  documentSpans: DocumentSpan[];
  artifactSpans: ArtifactSpan[];
  testExampleSpans: TestExampleSpan[];
  features: FeatureProjectionRecord[];
};

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function repoPath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\/+/, '');
}

function createLocator(input: {
  path: string;
  kind: SpanKind;
  headingPath?: string[];
  anchor?: string;
  normalizedTextHash: string;
  blockOrdinal?: number;
}) {
  return {
    path: input.path,
    kind: input.kind,
    headingPath: input.headingPath ?? [],
    blockOrdinal: input.blockOrdinal ?? 0,
    anchor: input.anchor,
    normalizedTextHash: input.normalizedTextHash,
    nearbyHeadingHash: sha1(JSON.stringify(input.headingPath ?? []))
  };
}

function createRepoSpan(input: {
  spanId: string;
  path: string;
  kind: SpanKind;
  role: FileRole;
  label: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  language: string;
  headingPath?: string[];
  symbolPath?: string[];
  anchor?: string;
  indexedText: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  source: string;
  blockOrdinal?: number;
}): RepoSpan {
  const textHash = sha1(input.indexedText);
  return {
    spanId: input.spanId,
    path: input.path,
    kind: input.kind,
    role: input.role,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine,
    startColumn: input.startColumn,
    endColumn: input.endColumn,
    language: input.language,
    headingPath: input.headingPath ?? [],
    symbolPath: input.symbolPath ?? [],
    anchor: input.anchor,
    stableLocator: createLocator({
      path: input.path,
      kind: input.kind,
      headingPath: input.headingPath,
      anchor: input.anchor,
      normalizedTextHash: textHash,
      blockOrdinal: input.blockOrdinal
    }),
    textHash,
    indexedText: input.indexedText,
    summary: input.summary ?? input.label,
    metadata: input.metadata ?? {},
    source: input.source,
    updatedAt: 0
  };
}

function fileSpan(projectRoot: string, file: InventoryFile): RepoSpan {
  return createRepoSpan({
    spanId: `file:${sha1(`${path.resolve(projectRoot)}:${file.path}:${file.contentHash}`)}`,
    path: repoPath(file.path),
    kind: 'file',
    role: file.role,
    label: repoPath(file.path),
    startLine: 1,
    endLine: Math.max(1, file.indexedText.split(/\r?\n/).length),
    language: file.language,
    indexedText: file.indexedText,
    summary: repoPath(file.path),
    metadata: {
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      generated: file.generated,
      oversized: file.oversized
    },
    source: 'file-inventory'
  });
}

function containsEdge(sourceSpanId: string, targetSpanId: string): RepoEdge {
  return {
    edgeId: `contains:${sha1(`${sourceSpanId}:${targetSpanId}`)}`,
    sourceSpanId,
    targetSpanId,
    relation: 'contains',
    confidence: 1,
    source: 'projection-builder',
    evidence: { kind: 'same_file_projection' },
    updatedAt: 0
  };
}

function projectDocumentSpan(projectRoot: string, span: DocumentSpan, blockOrdinal: number): RepoSpan {
  return createRepoSpan({
    spanId: createDocumentSpanId({
      projectRoot,
      path: span.path,
      headingPath: span.headingPath,
      kind: span.kind,
      blockOrdinal,
      normalizedTextHash: sha1(span.text)
    }),
    path: repoPath(span.path),
    kind: span.kind,
    role: classifyFileRole(span.path),
    label: span.label,
    startLine: span.startLine,
    endLine: span.endLine,
    language: languageForPath(span.path),
    headingPath: span.headingPath,
    anchor: span.anchor,
    indexedText: span.text,
    metadata: span.metadata,
    source: 'document-indexer',
    blockOrdinal
  });
}

function projectArtifactSpan(projectRoot: string, span: ArtifactSpan): RepoSpan {
  const pointer = String(span.metadata.pointer ?? span.metadata.jsonPointer ?? span.metadata.tomlPath ?? span.metadata.yamlPath ?? span.label);
  const identityRole =
    ['configKey', 'envVar', 'cliFlag', 'schemaFieldName']
      .map(key => {
        const value = span.metadata[key];
        return typeof value === 'string' && value ? `${key}:${value}` : undefined;
      })
      .find(Boolean) ?? `label:${span.label}`;
  return createRepoSpan({
    spanId: createConfigSpanId({
      projectRoot,
      path: span.path,
      jsonPointerOrTomlPath: `${pointer}#${identityRole}#line:${span.startLine}`,
      normalizedValueHash: sha1(span.text)
    }),
    path: repoPath(span.path),
    kind: span.kind,
    role: classifyFileRole(span.path),
    label: span.label,
    startLine: span.startLine,
    endLine: span.endLine,
    language: languageForPath(span.path),
    indexedText: span.text,
    metadata: span.metadata,
    source: 'artifact-indexer'
  });
}

function projectTestExampleSpan(projectRoot: string, span: TestExampleSpan): RepoSpan {
  return createRepoSpan({
    spanId: createTestExampleSpanId({
      projectRoot,
      path: span.path,
      kind: span.kind,
      testOrExampleName: span.label,
      normalizedTextHash: sha1(span.text),
      startLine: span.startLine
    }),
    path: repoPath(span.path),
    kind: span.kind,
    role: classifyFileRole(span.path),
    label: span.label,
    startLine: span.startLine,
    endLine: span.endLine,
    language: languageForPath(span.path),
    indexedText: span.text,
    metadata: span.metadata,
    source: 'test-example-indexer'
  });
}

function projectFeature(projectRoot: string, feature: FeatureProjectionRecord): RepoSpan {
  return createRepoSpan({
    spanId: createFeatureSpanId({
      projectRoot,
      featurePath: '.noemaloom/planning/features.json',
      featureLabel: feature.title,
      sourceId: feature.id
    }),
    path: '.noemaloom/planning/features.json',
    kind: 'feature.node',
    role: 'feature_plan',
    label: feature.title,
    startLine: 1,
    endLine: 1,
    language: 'json',
    indexedText: `${feature.id} ${feature.title}`,
    summary: feature.title,
    metadata: { id: feature.id, source: feature.source },
    source: 'feature-projection'
  });
}

function bySpanOrder(left: RepoSpan, right: RepoSpan): number {
  const group = (span: RepoSpan): number => {
    if (span.kind.startsWith('feature.')) return 0;
    if (span.kind === 'file') return 1;
    if (span.kind.startsWith('code.')) return 2;
    if (span.kind.startsWith('doc.')) return 3;
    if (span.kind.startsWith('config.')) return 4;
    return 5;
  };
  return (
    group(left) - group(right) ||
    left.path.localeCompare(right.path) ||
    left.label.localeCompare(right.label) ||
    left.spanId.localeCompare(right.spanId)
  );
}

export function buildProjectionGraph(input: BuildProjectionGraphInput): ProjectionGraph {
  const fileSpans = [...input.files].sort((left, right) => left.path.localeCompare(right.path)).map(file => fileSpan(input.projectRoot, file));
  const fileByPath = new Map(fileSpans.map(span => [span.path, span]));
  const projected = [
    ...input.codeSpans.map(span =>
      createRepoSpan({
        spanId: span.spanId,
        path: repoPath(span.path),
        kind: span.kind,
        role: classifyFileRole(span.path),
        label: span.label,
        startLine: span.startLine,
        endLine: span.endLine,
        startColumn: span.startColumn,
        endColumn: span.endColumn,
        language: languageForPath(span.path),
        symbolPath: [span.label],
        indexedText: span.text,
        metadata: span.metadata,
        source: 'code-fact-indexer'
      })
    ),
    ...input.documentSpans.map((span, index) => projectDocumentSpan(input.projectRoot, span, index)),
    ...input.artifactSpans.map(span => projectArtifactSpan(input.projectRoot, span)),
    ...input.testExampleSpans.map(span => projectTestExampleSpan(input.projectRoot, span))
  ];
  const featureSpans = [...input.features].sort((left, right) => left.id.localeCompare(right.id)).map(feature => projectFeature(input.projectRoot, feature));
  const containsEdges = projected
    .map(span => {
      const file = fileByPath.get(span.path);
      return file ? containsEdge(file.spanId, span.spanId) : undefined;
    })
    .filter((edge): edge is RepoEdge => Boolean(edge))
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));

  return {
    spans: [...featureSpans, ...fileSpans, ...projected].sort(bySpanOrder),
    edges: containsEdges
  };
}
