import type { FileRole, SpanKind } from '../spans/enums.js';
import { classifyPathLayer, isBusinessPathLayer } from '../files/path-layer.js';
import { weightedReciprocalRankScore, type WeightedRoute } from './rrf.js';
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
  routeFusionScore: number;
  freshnessScore: number;
  generatedFilePenalty: number;
  vendorFilePenalty: number;
  boundaryRiskPenalty: number;
  staleIndexPenalty: number;
  deprecatedSymbolPenalty: number;
  redactionPenalty: number;
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

function compactIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function basenameStem(repoPath: string): string {
  const basename = repoPath.split('/').at(-1) ?? repoPath;
  return basename.replace(/\.[^.]+$/, '');
}

function pathMatchStrength(candidate: LocatorCandidate, query: NormalizedQuery): number {
  let best = 0;
  const candidatePath = candidate.path.toLowerCase();
  const basename = candidatePath.split('/').at(-1) ?? candidatePath;
  const compactRaw = compactIdentifier(query.raw);
  const compactStem = compactIdentifier(basenameStem(candidate.path));
  if (compactStem.length >= 4 && compactRaw.includes(compactStem)) {
    best = Math.max(best, 36);
  }
  for (const term of query.pathTerms) {
    const normalized = normalizedPathTerm(term).toLowerCase();
    const compactTerm = compactIdentifier(normalized);
    if (candidatePath === normalized || candidatePath.endsWith(`/${normalized}`)) {
      best = Math.max(best, 42);
    } else if (basename === normalized) {
      best = Math.max(best, 24);
    } else if (candidatePath.includes(normalized)) {
      best = Math.max(best, 10);
    } else if (compactTerm.length >= 4 && compactStem === compactTerm) {
      best = Math.max(best, 34);
    } else if (compactTerm.length >= 6 && (compactStem.includes(compactTerm) || compactTerm.includes(compactStem))) {
      best = Math.max(best, 18);
    }
  }
  return best;
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function splitStructuredTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const char of value.toLowerCase()) {
    const isSeparator = char === '_' || char === '-' || char === '.' || char === ':';
    const isLetter = char.toLocaleLowerCase() !== char.toLocaleUpperCase();
    const isTokenChar = !isSeparator && (isLetter || isDigit(char));
    if (isTokenChar) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens.filter(token => token.length >= 3);
}

function queryAllowsFeatureCandidate(query: NormalizedQuery, candidate: LocatorCandidate): boolean {
  if (query.targetRoles.includes(candidate.role as FileRole)) {
    return true;
  }
  const candidateSurfaceTokens = new Set([
    ...splitStructuredTokens(String(candidate.role)),
    ...splitStructuredTokens(String(candidate.kind)),
    ...candidate.sourcePlanSources.flatMap(splitStructuredTokens)
  ]);
  const queryTokens = new Set([
    ...query.exactTerms,
    ...query.pathTerms,
    ...query.symbolTerms,
    ...query.configTerms
  ].map(term => term.toLowerCase()));
  return [...candidateSurfaceTokens].some(token => queryTokens.has(token));
}

function isFeatureCandidate(candidate: LocatorCandidate): boolean {
  return String(candidate.kind).startsWith('feature.') || candidate.role === 'feature_plan' || candidate.sourcePlanSources.includes('feature_projection');
}

function exactPathOrBasenameMatch(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return pathMatchStrength(candidate, query) >= 24;
}

function exactPathRequested(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  const candidatePath = candidate.path.toLowerCase();
  return query.pathTerms.some(term => {
    const normalized = normalizedPathTerm(term).toLowerCase();
    return candidatePath === normalized || candidatePath.endsWith(`/${normalized}`);
  });
}

function pathLayerAllowed(candidate: LocatorCandidate, query: NormalizedQuery, options: { includeGeneratedVendor?: boolean }): boolean {
  const layer = classifyPathLayer(candidate.path);
  if (isBusinessPathLayer(layer)) return true;
  if (exactPathRequested(candidate, query)) return true;
  if (candidate.role === 'feature_plan' && query.targetRoles.includes('feature_plan')) return true;
  if (options.includeGeneratedVendor && ['generated', 'vendor'].includes(layer)) return true;
  return false;
}

function pathContainsTerm(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return pathMatchStrength(candidate, query) > 0;
}

function exactSymbolLabel(candidate: LocatorCandidate, query: NormalizedQuery): boolean {
  return query.symbolTerms.some(term => candidate.label === term || candidate.symbolPath.includes(term));
}

function queryWantsParagraph(query: NormalizedQuery): boolean {
  const raw = query.raw.toLowerCase();
  return raw.includes('paragraph');
}

function queryWantsTableRow(query: NormalizedQuery): boolean {
  return query.docTerms.some(term => ['table', 'row', 'rows'].includes(term));
}

const CONTENT_INTENT_NOISE = new Set([
  'find',
  'document',
  'paragraph',
  'defines',
  'that',
  'this',
  'with',
  'requested',
  'direct'
]);

function contentSpecificTerms(query: NormalizedQuery): string[] {
  return [...new Set([...query.exactTerms, ...query.symbolTerms, ...query.featureTerms])]
    .map(term => term.toLowerCase())
    .filter(term => term.length >= 4 && !CONTENT_INTENT_NOISE.has(term) && !term.includes('.') && !term.endsWith('_'));
}

function routeWeight(source: string): number {
  switch (source) {
    case 'code_symbol_name_signature':
      return 8;
    case 'fts_lexical':
      return 4;
    case 'markdown_heading_anchor_inline_code':
    case 'config_cli_env_schema':
    case 'old_term_sweep':
      return 3;
    case 'path_role_expansion':
    case 'test_example_import_call':
    case 'feature_projection':
      return 2;
    case 'cross_reference_edge':
      return 1;
    default:
      return 1;
  }
}

function routeFusionScore(candidate: LocatorCandidate): number {
  const routes: WeightedRoute[] = candidate.sourcePlanSources.map((source, index) => ({
    route: source,
    rank: index + 1,
    weight: routeWeight(source)
  }));
  return weightedReciprocalRankScore(routes, { cap: 24 });
}

function metadataFlag(candidate: LocatorCandidate, key: string): boolean {
  return candidate.metadata?.[key] === true;
}

function kindPrecisionScore(candidate: LocatorCandidate, query: NormalizedQuery): number {
  const kind = String(candidate.kind);
  if (kind.startsWith('code.') && exactSymbolLabel(candidate, query)) {
    if (['code.function', 'code.method', 'code.class', 'code.constant', 'code.component'].includes(kind)) return 18;
    if (kind === 'code.module') return 4;
    return 10;
  }
  if (queryWantsTableRow(query)) {
    const contentTerms = contentSpecificTerms(query);
    if (kind === 'doc.table_row') {
      return 26 + Math.min(36, countHits(contentTerms, candidate.indexedText.toLowerCase()) * 4);
    }
    if (kind === 'doc.table') {
      return 12 + Math.min(20, countHits(contentTerms, candidate.indexedText.toLowerCase()) * 2);
    }
  }
  if (kind === 'doc.paragraph' && (queryWantsParagraph(query) || exactPathOrBasenameMatch(candidate, query))) {
    const contentTerms = contentSpecificTerms(query);
    return 14 + Math.min(60, countHits(contentTerms, candidate.indexedText.toLowerCase()) * 6);
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
    (pathMatchStrength(candidate, query) || (pathContainsTerm(candidate, query) ? 10 : 0)) +
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
  const routeScore = routeFusionScore(candidate);
  const freshnessScore = candidate.boundary.stale ? 0 : 5;
  const generatedFilePenalty = candidate.file.generated || candidate.role === 'generated_file' ? 15 : 0;
  const vendorFilePenalty = candidate.file.vendor || candidate.role === 'vendor_file' ? 15 : 0;
  const boundaryRiskPenalty = candidate.boundary.risk === 'high' ? 20 : candidate.boundary.risk === 'medium' ? 10 : 0;
  const staleIndexPenalty = candidate.boundary.stale ? 15 : 0;
  const deprecatedSymbolPenalty = metadataFlag(candidate, 'deprecated') ? 16 : 0;
  const redactionPenalty = metadataFlag(candidate, 'redactedAtIndexWrite') ? 4 : 0;

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
    routeFusionScore: routeScore,
    freshnessScore,
    generatedFilePenalty,
    vendorFilePenalty,
    boundaryRiskPenalty,
    staleIndexPenalty,
    deprecatedSymbolPenalty,
    redactionPenalty
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
    breakdown.routeFusionScore +
    breakdown.freshnessScore -
    breakdown.generatedFilePenalty -
    breakdown.vendorFilePenalty -
    breakdown.boundaryRiskPenalty -
    breakdown.staleIndexPenalty -
    breakdown.deprecatedSymbolPenalty -
    breakdown.redactionPenalty
  );
}

export function rankCandidates(
  candidates: LocatorCandidate[],
  query: NormalizedQuery,
  options: { includeGeneratedVendor?: boolean } = {}
): RankedCandidate[] {
  return candidates
    .filter(candidate => options.includeGeneratedVendor || (!candidate.file.generated && !candidate.file.vendor && !['generated_file', 'vendor_file'].includes(candidate.role)))
    .filter(candidate => pathLayerAllowed(candidate, query, options))
    .filter(candidate => !isFeatureCandidate(candidate) || queryAllowsFeatureCandidate(query, candidate))
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
