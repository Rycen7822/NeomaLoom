import type { FileRole, SpanKind } from '../spans/enums.js';
import type { BoundaryValidation } from './boundary-validation.js';
import type { NormalizedQuery } from './query-normalizer.js';

export type LocatorDecision = 'must_edit' | 'maybe_edit' | 'inspect_only' | 'verify_only';

export type LocatorCandidate = {
  spanId: string;
  path: string;
  kind: SpanKind | string;
  role: FileRole | string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  symbolPath: string[];
  indexedText: string;
  summary: string;
  source: string;
  sourcePlanSources: string[];
  evidence: Array<Record<string, unknown>>;
  linkedSpans: Array<{ spanId: string; confidence: number; relation?: string }>;
  boundary: BoundaryValidation;
  file: { ignored: boolean; generated: boolean; vendor: boolean };
  coverageRole?: string;
  fileContentHash?: string;
  textHash?: string;
  anchor?: string;
  stableLocator?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  indexed?: boolean;
  promotionAction?: { target: 'paths'; paths: string[]; reason: string };
};

export type ScoreBreakdown = {
  exactTermScore: number;
  symbolMatchScore: number;
  headingMatchScore: number;
  configKeyScore: number;
  pathRoleScore: number;
  linkConfidenceScore: number;
  featureRelevanceScore: number;
  canonicalityScore: number;
  coverageDiversityScore: number;
  kindPrecisionScore: number;
  freshnessScore: number;
  generatedFilePenalty: number;
  vendorFilePenalty: number;
  boundaryRiskPenalty: number;
  staleIndexPenalty: number;
};

export type RankedCandidate = LocatorCandidate & {
  score: number;
  scoreBreakdown: ScoreBreakdown;
};

function searchable(candidate: LocatorCandidate): string {
  return [
    candidate.path,
    candidate.label,
    candidate.kind,
    candidate.role,
    candidate.headingPath.join(' '),
    candidate.symbolPath.join(' '),
    candidate.indexedText,
    candidate.summary,
    JSON.stringify(candidate.metadata ?? {})
  ]
    .join('\n')
    .toLowerCase();
}

function countHits(terms: string[], text: string): number {
  return terms.filter(term => text.includes(term.toLowerCase())).length;
}

function hasCaseSensitiveHit(terms: string[], candidate: LocatorCandidate): boolean {
  const haystack = [
    candidate.path,
    candidate.label,
    candidate.headingPath.join(' '),
    candidate.symbolPath.join(' '),
    candidate.indexedText,
    candidate.summary,
    JSON.stringify(candidate.metadata ?? {})
  ].join('\n');
  return terms.some(term => haystack.includes(term));
}

function normalizedPathTerm(term: string): string {
  return term.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function exactPathOrBasenameMatch(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return query.pathTerms.some(term => {
    const normalized = normalizedPathTerm(term).toLowerCase();
    const candidatePath = candidate.path.toLowerCase();
    const basename = candidatePath.split('/').at(-1) ?? candidatePath;
    return candidatePath === normalized || basename === normalized || candidatePath.endsWith(`/${normalized}`);
  });
}

function pathContainsTerm(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return query.pathTerms.some(term => candidate.path.toLowerCase().includes(normalizedPathTerm(term).toLowerCase()));
}

function exactSymbolLabel(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return query.symbolTerms.some(term => candidate.label === term || candidate.symbolPath.includes(term));
}

function queryWantsParagraph(query: NormalizedQuery): boolean {
  const raw = query.raw.toLowerCase();
  return raw.includes('paragraph') || raw.includes('段落');
}

function kindPrecisionScore(candidate: LocatorCandidate, query: NormalizedQuery): number {
  const kind = String(candidate.kind);
  if (kind.startsWith('code.') && exactSymbolLabel(candidate, query)) {
    if (['code.function', 'code.method', 'code.class', 'code.constant', 'code.component'].includes(kind)) return 18;
    if (kind === 'code.module') return 4;
    return 10;
  }
  if (kind === 'doc.paragraph' && (queryWantsParagraph(query) || exactPathOrBasenameMatch(candidate, query))) {
    const contentTerms = [...query.exactTerms, ...query.featureTerms].filter(term => !term.includes('/') && !term.endsWith('.md'));
    return 14 + Math.min(30, countHits(contentTerms, candidate.indexedText.toLowerCase()) * 4);
  }
  if ((kind === 'doc.heading' || kind === 'doc.section') && queryWantsParagraph(query)) {
    return -8;
  }
  if (kind === 'file' && query.symbolTerms.length > 0) {
    return -6;
  }
  return 0;
}

function scoreCandidate(candidate: LocatorCandidate, query: NormalizedQuery): ScoreBreakdown {
  const text = searchable(candidate);
  const exactTermScore = Math.min(20, countHits(query.exactTerms, text) * 5);
  const symbolMatchScore = hasCaseSensitiveHit(query.symbolTerms, candidate) ? 15 : 0;
  const headingText = [candidate.label, candidate.headingPath.join(' ')].join(' ').toLowerCase();
  const headingMatchScore = countHits([...query.docTerms, ...query.featureTerms], headingText) > 0 ? 10 : 0;
  const configKeyScore = hasCaseSensitiveHit(query.configTerms, candidate) ? 8 : 0;
  const pathRoleScore = Math.min(
    56,
    (exactPathOrBasenameMatch(candidate, query) ? 42 : pathContainsTerm(candidate, query) ? 10 : 0) +
      (query.targetRoles.includes(candidate.role as FileRole) ? 8 : 0)
  );
  const linkConfidenceScore = Math.round(Math.min(1, Math.max(0, ...candidate.linkedSpans.map(span => span.confidence), 0)) * 10);
  const featureRelevanceScore =
    (countHits(query.featureTerms, text) > 0 ? 6 : 0) +
    (/\bdocumentation\b/i.test(query.raw) && String(candidate.role).endsWith('_doc') ? 11 : 0);
  const canonicalityScore = ['canonical_api_doc', 'readme_doc', 'quickstart_doc', 'tutorial_doc', 'example_doc', 'source_file', 'test_file'].includes(candidate.role)
    ? 6
    : 0;
  const coverageDiversityScore = candidate.coverageRole || query.targetRoles.includes(candidate.role as FileRole) ? 4 : 0;
  const precisionScore = kindPrecisionScore(candidate, query);
  const freshnessScore = candidate.boundary.stale ? 0 : 5;
  const generatedFilePenalty = candidate.file.generated || candidate.role === 'generated_file' ? 15 : 0;
  const vendorFilePenalty = candidate.file.vendor || candidate.role === 'vendor_file' ? 15 : 0;
  const boundaryRiskPenalty = candidate.boundary.risk === 'high' ? 20 : candidate.boundary.risk === 'medium' ? 10 : 0;
  const staleIndexPenalty = candidate.boundary.stale ? 15 : 0;

  return {
    exactTermScore,
    symbolMatchScore,
    headingMatchScore,
    configKeyScore,
    pathRoleScore,
    linkConfidenceScore,
    featureRelevanceScore,
    canonicalityScore,
    coverageDiversityScore,
    kindPrecisionScore: precisionScore,
    freshnessScore,
    generatedFilePenalty,
    vendorFilePenalty,
    boundaryRiskPenalty,
    staleIndexPenalty
  };
}

function sumBreakdown(breakdown: ScoreBreakdown): number {
  return (
    breakdown.exactTermScore +
    breakdown.symbolMatchScore +
    breakdown.headingMatchScore +
    breakdown.configKeyScore +
    breakdown.pathRoleScore +
    breakdown.linkConfidenceScore +
    breakdown.featureRelevanceScore +
    breakdown.canonicalityScore +
    breakdown.coverageDiversityScore +
    breakdown.kindPrecisionScore +
    breakdown.freshnessScore -
    breakdown.generatedFilePenalty -
    breakdown.vendorFilePenalty -
    breakdown.boundaryRiskPenalty -
    breakdown.staleIndexPenalty
  );
}

export function rankCandidates(
  candidates: LocatorCandidate[],
  query: NormalizedQuery,
  options: { includeGeneratedVendor?: boolean } = {}
): RankedCandidate[] {
  return candidates
    .filter(candidate => options.includeGeneratedVendor || (!candidate.file.generated && !candidate.file.vendor && !['generated_file', 'vendor_file'].includes(candidate.role)))
    .map(candidate => {
      const scoreBreakdown = scoreCandidate(candidate, query);
      return {
        ...candidate,
        score: sumBreakdown(scoreBreakdown),
        scoreBreakdown
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine ||
        left.spanId.localeCompare(right.spanId)
    );
}
