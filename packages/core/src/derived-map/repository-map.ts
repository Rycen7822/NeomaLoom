import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { EdgeRelation, FileRole, SpanKind } from '../spans/enums.js';
import { isDefaultBusinessPath } from '../files/path-layer.js';
import type { RepoEdge, RepoSpan } from '../spans/types.js';
import { writeFileInsideStateDir } from '../safety/path-guard.js';
import { renderRepositoryMapMarkdown } from './repository-map-markdown.js';

export type RepositoryMap = {
  graphRevision: string;
  directoryRoles: Array<{ path: string; roles: FileRole[]; spanCount: number }>;
  canonicalDocs: Array<{ path: string; label: string; role: FileRole }>;
  coreSourceModules: Array<{ path: string; label: string; kind: SpanKind }>;
  testEntries: Array<{ path: string; label: string; kind: SpanKind }>;
  configEntries: Array<{ path: string; label: string; kind: SpanKind }>;
  featureClusters: Array<{ id: string; label: string; linkedSpanIds: string[] }>;
  highConfidenceLinks: Array<{
    sourceSpanId: string;
    targetSpanId: string;
    relation: EdgeRelation;
    confidence: number;
    evidenceKind: string;
  }>;
  warnings: string[];
};

export type BuildRepositoryMapInput = {
  projectRoot: string;
  graphRevision: string;
  spans: RepoSpan[];
  edges: RepoEdge[];
  warnings?: string[];
};

const FORBIDDEN_TERMS = [
  'chat summary',
  'experiment conclusion',
  'user preference',
  'agent experience',
  'long-term memory',
  'full code snippet',
  'unanchored judgment'
];

function isRepositoryMapBusinessSpan(span: RepoSpan): boolean {
  if (span.role === 'feature_plan' && span.kind === 'feature.node') return true;
  return isDefaultBusinessPath(span.path);
}

function hasForbiddenContent(span: RepoSpan): boolean {
  if (!isRepositoryMapBusinessSpan(span)) {
    return true;
  }
  if (span.role === 'experiment_note_doc') {
    return true;
  }
  const text = `${span.path}\n${span.label}\n${span.summary}\n${span.indexedText}`.toLowerCase();
  return FORBIDDEN_TERMS.some(term => text.includes(term));
}

function sortByPathLabel<T extends { path: string; label: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.path.localeCompare(right.path) || left.label.localeCompare(right.label));
}

function directoryOf(repoPath: string): string {
  const normalized = repoPath.replaceAll('\\', '/');
  if (!normalized.includes('/')) {
    return '.';
  }
  return normalized.split('/', 1)[0];
}

function evidenceKind(edge: RepoEdge): string {
  if (edge.evidence && typeof edge.evidence === 'object' && 'kind' in edge.evidence) {
    return String((edge.evidence as { kind?: unknown }).kind ?? 'unknown');
  }
  return 'unknown';
}

export function buildRepositoryMap(input: BuildRepositoryMapInput): RepositoryMap {
  const safeSpans = [...input.spans].filter(span => !hasForbiddenContent(span));
  const safeSpanIds = new Set(safeSpans.map(span => span.spanId));
  const rolesByDir = new Map<string, { roles: Set<FileRole>; spanCount: number }>();

  for (const span of safeSpans) {
    const dir = directoryOf(span.path);
    const entry = rolesByDir.get(dir) ?? { roles: new Set<FileRole>(), spanCount: 0 };
    entry.roles.add(span.role);
    entry.spanCount += 1;
    rolesByDir.set(dir, entry);
  }

  const highConfidenceLinks = [...input.edges]
    .filter(edge => edge.confidence >= 0.6 && safeSpanIds.has(edge.sourceSpanId) && safeSpanIds.has(edge.targetSpanId))
    .map(edge => ({
      sourceSpanId: edge.sourceSpanId,
      targetSpanId: edge.targetSpanId,
      relation: edge.relation,
      confidence: edge.confidence,
      evidenceKind: evidenceKind(edge)
    }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.sourceSpanId.localeCompare(right.sourceSpanId) ||
        left.targetSpanId.localeCompare(right.targetSpanId) ||
        left.relation.localeCompare(right.relation)
    );

  return {
    graphRevision: input.graphRevision,
    directoryRoles: [...rolesByDir.entries()]
      .map(([dir, entry]) => ({
        path: dir,
        roles: [...entry.roles].sort(),
        spanCount: entry.spanCount
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    canonicalDocs: sortByPathLabel(
      safeSpans
        .filter(span => ['canonical_api_doc', 'readme_doc', 'tutorial_doc', 'design_doc'].includes(span.role))
        .map(span => ({ path: span.path, label: span.label, role: span.role }))
    ),
    coreSourceModules: sortByPathLabel(
      safeSpans
        .filter(span => span.role === 'source_file' && span.kind.startsWith('code.'))
        .map(span => ({ path: span.path, label: span.label, kind: span.kind }))
    ),
    testEntries: sortByPathLabel(
      safeSpans
        .filter(span => span.kind.startsWith('test.'))
        .map(span => ({ path: span.path, label: span.label, kind: span.kind }))
    ),
    configEntries: sortByPathLabel(
      safeSpans
        .filter(span => span.kind.startsWith('config.'))
        .map(span => ({ path: span.path, label: span.label, kind: span.kind }))
    ),
    featureClusters: sortByPathLabel(
      safeSpans
        .filter(span => span.kind === 'feature.node')
        .map(span => ({
          id: span.spanId,
          path: span.path,
          label: span.label,
          linkedSpanIds: highConfidenceLinks
            .filter(edge => edge.sourceSpanId === span.spanId || edge.targetSpanId === span.spanId)
            .flatMap(edge => [edge.sourceSpanId, edge.targetSpanId])
            .filter(spanId => spanId !== span.spanId)
            .sort()
        }))
    ).map(({ id, label, linkedSpanIds }) => ({ id, label, linkedSpanIds })),
    highConfidenceLinks,
    warnings: [...new Set(input.warnings ?? [])].sort()
  };
}

export async function writeRepositoryMap(input: { projectRoot: string; map: RepositoryMap }): Promise<void> {
  const targetDir = path.join(path.resolve(input.projectRoot), '.noemaloom', 'derived-map');
  await mkdir(targetDir, { recursive: true });
  await writeFileInsideStateDir(input.projectRoot, path.join(targetDir, 'repository-map.json'), `${JSON.stringify(input.map, null, 2)}\n`);
  await writeFileInsideStateDir(input.projectRoot, path.join(targetDir, 'repository-map.md'), renderRepositoryMapMarkdown(input.map));
}
