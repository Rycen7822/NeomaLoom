import { normalizeQuery } from '../../packages/core/src/locator/query-normalizer.js';
import { rankCandidates, type LocatorCandidate } from '../../packages/core/src/locator/ranking.js';
import { decideCandidate } from '../../packages/core/src/locator/decision.js';

const baseCandidate: LocatorCandidate = {
  spanId: 'span-doc-client',
  path: 'docs/api/client.md',
  kind: 'doc.paragraph',
  role: 'canonical_api_doc',
  label: 'Client API timeout option',
  startLine: 10,
  endLine: 12,
  headingPath: ['Client API', 'Options'],
  symbolPath: [],
  indexedText: 'createClient accepts --timeout and timeoutMs in the Client API.',
  summary: 'createClient timeout option',
  source: 'document-indexer',
  sourcePlanSources: ['fts_lexical', 'markdown_anchor', 'path_role_expansion'],
  evidence: [{ kind: 'direct_text_match', value: 'createClient timeout' }],
  linkedSpans: [{ spanId: 'span-code-create-client', confidence: 0.8 }],
  boundary: { ok: true, stale: false, risk: 'low' as const, warnings: [] },
  file: { ignored: false, generated: false, vendor: false },
  coverageRole: 'canonical_api_doc'
};

describe('locator query normalization and ranking', () => {
  it('extracts paths, symbols, config keys, feature terms, old/new terms, and target roles', () => {
    const normalized = normalizeQuery({
      query:
        'Update docs/api/client.md Client API for createClient --timeout and API_TIMEOUT from legacyTimeout to timeoutMs',
      targetRoles: ['canonical_api_doc', 'source_file']
    });

    expect(normalized.pathTerms).toContain('docs/api/client.md');
    expect(normalized.symbolTerms).toEqual(expect.arrayContaining(['createClient', 'legacyTimeout', 'timeoutMs']));
    expect(normalized.configTerms).toEqual(expect.arrayContaining(['--timeout', 'API_TIMEOUT']));
    expect(normalized.docTerms).toEqual(expect.arrayContaining(['client', 'api']));
    expect(normalized.featureTerms).toEqual(expect.arrayContaining(['timeout']));
    expect(normalized.oldTerms).toContain('legacyTimeout');
    expect(normalized.newTerms).toContain('timeoutMs');
    expect(normalized.targetRoles).toEqual(['canonical_api_doc', 'source_file']);
  });

  it('extracts Unicode file paths intact for Codex-style targets', () => {
    const normalized = normalizeQuery({
      query: 'Plan DeepScientist/quests/001/STAGE10_推进规划.md with CURRENT_STATUS.md'
    });

    expect(normalized.pathTerms).toEqual(expect.arrayContaining([
      'DeepScientist/quests/001/STAGE10_推进规划.md',
      'CURRENT_STATUS.md'
    ]));
  });

  it('returns deterministic score breakdowns and decisions from the fixed formula', () => {
    const normalized = normalizeQuery({
      query: 'Update docs/api/client.md for createClient --timeout timeout option',
      targetRoles: ['canonical_api_doc']
    });

    const [ranked] = rankCandidates([baseCandidate], normalized);

    expect(ranked.scoreBreakdown).toEqual({
      exactTermScore: 20,
      symbolMatchScore: 15,
      headingMatchScore: 10,
      configKeyScore: 8,
      pathRoleScore: 16,
      linkConfidenceScore: 8,
      featureRelevanceScore: 6,
      canonicalityScore: 6,
      coverageDiversityScore: 4,
      freshnessScore: 5,
      generatedFilePenalty: 0,
      vendorFilePenalty: 0,
      boundaryRiskPenalty: 0,
      staleIndexPenalty: 0
    });
    expect(ranked.score).toBe(98);
    expect(decideCandidate(ranked)).toMatchObject({
      decision: 'must_edit',
      reason: expect.stringContaining('score >= 85')
    });
  });

  it('keeps similar documentation paragraphs instead of collapsing them', () => {
    const normalized = normalizeQuery({
      query: 'Update createClient timeout docs',
      targetRoles: ['canonical_api_doc', 'readme_doc']
    });
    const ranked = rankCandidates(
      [
        baseCandidate,
        {
          ...baseCandidate,
          spanId: 'span-readme-client',
          path: 'README.md',
          role: 'readme_doc',
          label: 'Client API timeout option',
          coverageRole: 'readme_doc'
        }
      ],
      normalized
    );

    expect(ranked.map(candidate => candidate.spanId)).toEqual([
      'span-doc-client',
      'span-readme-client'
    ]);
  });

  it('excludes generated and vendor candidates unless explicitly requested', () => {
    const normalized = normalizeQuery({
      query: 'Update createClient generated docs',
      targetRoles: ['canonical_api_doc']
    });
    const generated = {
      ...baseCandidate,
      spanId: 'span-dist-client',
      path: 'dist/client.md',
      role: 'generated_file',
      file: { ignored: false, generated: true, vendor: false }
    };

    expect(rankCandidates([generated], normalized)).toEqual([]);
    expect(rankCandidates([generated], normalized, { includeGeneratedVendor: true })).toHaveLength(1);
  });
});
