import { decideCandidate } from '../../packages/core/src/locator/decision.js';
import type { RankedCandidate, ScoreBreakdown } from '../../packages/core/src/locator/ranking.js';

const zeroBreakdown: ScoreBreakdown = {
  exactTermScore: 0,
  symbolMatchScore: 0,
  headingMatchScore: 0,
  configKeyScore: 0,
  pathRoleScore: 0,
  linkConfidenceScore: 0,
  featureRelevanceScore: 0,
  canonicalityScore: 0,
  coverageDiversityScore: 0,
  kindPrecisionScore: 0,
  routeFusionScore: 0,
  freshnessScore: 0,
  generatedFilePenalty: 0,
  vendorFilePenalty: 0,
  boundaryRiskPenalty: 0,
  staleIndexPenalty: 0,
  deprecatedSymbolPenalty: 0,
  redactionPenalty: 0
};

function candidate(score: number): RankedCandidate {
  return {
    spanId: `span:${score}`,
    path: 'src/service.ts',
    kind: 'code.symbol.function',
    role: 'source_file',
    label: 'handler',
    startLine: 1,
    endLine: 3,
    headingPath: [],
    symbolPath: ['handler'],
    indexedText: 'export function handler() {}',
    summary: 'handler',
    source: 'test',
    sourcePlanSources: ['code_symbol_name_signature'],
    evidence: [{ source: 'test' }],
    linkedSpans: [],
    boundary: { ok: true, stale: false, risk: 'low', warnings: [] },
    file: { ignored: false, generated: false, vendor: false },
    score,
    scoreBreakdown: zeroBreakdown
  };
}

describe('locator candidate decision confidence', () => {
  it('keeps decisions stable while avoiding early confidence saturation above score 100', () => {
    const score85 = decideCandidate(candidate(85));
    const score120 = decideCandidate(candidate(120));
    const score180 = decideCandidate(candidate(180));

    expect(score85.decision).toBe('must_edit');
    expect(score120.decision).toBe('must_edit');
    expect(score180.decision).toBe('must_edit');

    expect(score85.confidence).toBeGreaterThan(0);
    expect(score85.confidence).toBeLessThan(score120.confidence);
    expect(score120.confidence).toBeGreaterThan(0.85);
    expect(score120.confidence).toBeLessThan(1);
    expect(score180.confidence).toBeGreaterThan(score120.confidence);
    expect(score180.confidence).toBeLessThanOrEqual(1);
  });
});
