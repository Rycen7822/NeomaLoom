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
      pathRoleScore: 50,
      linkConfidenceScore: 8,
      featureRelevanceScore: 6,
      canonicalityScore: 6,
      coverageDiversityScore: 4,
      kindPrecisionScore: 38,
      routeFusionScore: 11,
      freshnessScore: 5,
      generatedFilePenalty: 0,
      vendorFilePenalty: 0,
      boundaryRiskPenalty: 0,
      staleIndexPenalty: 0,
      deprecatedSymbolPenalty: 0,
      redactionPenalty: 0
    });
    expect(ranked.score).toBe(181);
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

  it('keeps file extension tokens out of exact terms while preserving explicit Unicode path terms', () => {
    const normalized = normalizeQuery({
      query: 'Find Gate-4 in docs/甲乙丙.md claim alignment table row'
    });

    expect(normalized.pathTerms).toContain('docs/甲乙丙.md');
    expect(normalized.pathTerms).not.toContain('.md');
    expect(normalized.pathTerms).not.toContain('md');
    expect(normalized.exactTerms).not.toContain('.md');
    expect(normalized.exactTerms).not.toContain('md');
    expect(normalized.docTerms).toEqual(expect.arrayContaining(['table', 'row']));
  });

  it('does not treat descriptive CJK slash phrases as repo paths', () => {
    const normalized = normalizeQuery({
      query: '精确英文/代码 path v2/models/protocsr_g8.py docs/中文说明.md'
    });

    expect(normalized.pathTerms).toEqual(expect.arrayContaining(['v2/models/protocsr_g8.py', 'docs/中文说明.md']));
    expect(normalized.pathTerms).not.toContain('精确英文/代码');
  });

  it('filters non-business tooling and artifact layers from default ranking', () => {
    const normalized = normalizeQuery({ query: 'update createClient documentation', targetRoles: ['document'] });
    const toolingDoc = {
      ...baseCandidate,
      spanId: 'span-agent-skill',
      path: '.agents/skills/create-client/SKILL.md',
      role: 'design_doc',
      indexedText: 'createClient documentation'
    };
    const artifactDoc = {
      ...baseCandidate,
      spanId: 'span-artifact-doc',
      path: 'artifacts/daily/create-client.md',
      role: 'design_doc',
      indexedText: 'createClient documentation'
    };

    expect(rankCandidates([toolingDoc, artifactDoc, baseCandidate], normalized).map(candidate => candidate.spanId)).toEqual([
      'span-doc-client'
    ]);
  });

  it('ranks table rows above whole tables for table-row intent', () => {
    const normalized = normalizeQuery({ query: 'Find Gate-4 claim alignment table row' });
    const table = {
      ...baseCandidate,
      spanId: 'span-table',
      path: 'docs/甲乙丙.md',
      kind: 'doc.table',
      label: 'table',
      indexedText: 'Gate-4 claim alignment top-k route weights pass condition',
      summary: 'claim alignment table'
    };
    const tableRow = {
      ...baseCandidate,
      spanId: 'span-table-row',
      path: 'docs/甲乙丙.md',
      kind: 'doc.table_row',
      label: 'Gate-4 | claim alignment | top-k route weights',
      indexedText: 'Gate-4 | claim alignment | top-k route weights pass condition',
      summary: 'Gate-4 claim alignment row'
    };

    const ranked = rankCandidates([table, tableRow], normalized);
    expect(ranked[0].spanId).toBe('span-table-row');
    expect(ranked[0].scoreBreakdown.kindPrecisionScore).toBeGreaterThan(ranked[1].scoreBreakdown.kindPrecisionScore);
  });

  it('prefers exact relative path matches over same-basename matches', () => {
    const normalized = normalizeQuery({ query: 'Inspect packages/active/src/config_loader.ts model config resolution' });
    const exactPath = {
      ...baseCandidate,
      spanId: 'span-exact-path',
      path: 'packages/active/src/config_loader.ts',
      role: 'source_file',
      kind: 'code.module',
      indexedText: 'model config resolution'
    };
    const sameBasename = {
      ...exactPath,
      spanId: 'span-same-basename',
      path: 'packages/legacy/src/config_loader.ts'
    };

    const ranked = rankCandidates([sameBasename, exactPath], normalized);
    expect(ranked[0].spanId).toBe('span-exact-path');
    expect(ranked[0].scoreBreakdown.pathRoleScore).toBeGreaterThan(ranked[1].scoreBreakdown.pathRoleScore);
  });

  it('uses compact Unicode basename identity for spaced non-ASCII title fragments', () => {
    const normalized = normalizeQuery({ query: '甲乙 丙丁', targetRoles: ['document'] });
    const exactUnicodeBasename = {
      ...baseCandidate,
      spanId: 'span-compact-unicode-basename',
      path: 'docs/甲乙丙丁.md',
      role: 'design_doc',
      label: '甲乙丙丁',
      indexedText: 'shared unicode body'
    };
    const neighboringUnicodeBasename = {
      ...baseCandidate,
      spanId: 'span-neighboring-unicode-basename',
      path: 'docs/甲乙丙戊.md',
      role: 'design_doc',
      label: '甲乙丙戊',
      indexedText: 'shared unicode body 甲乙 丙丁'
    };

    const ranked = rankCandidates([neighboringUnicodeBasename, exactUnicodeBasename], normalized);

    expect(ranked[0].spanId).toBe('span-compact-unicode-basename');
    expect(ranked[0].scoreBreakdown.pathRoleScore).toBeGreaterThan(ranked[1].scoreBreakdown.pathRoleScore);
  });

  it('gates feature-projection candidates by structured role intent instead of broad content terms', () => {
    const docQuery = normalizeQuery({ query: 'update createClient documentation', targetRoles: ['canonical_api_doc'] });
    const featureCandidate = {
      ...baseCandidate,
      spanId: 'span-feature-node',
      path: '.noemaloom/planning/features.json',
      kind: 'feature.node',
      role: 'feature_plan',
      label: 'createClient documentation',
      sourcePlanSources: ['feature_projection'],
      indexedText: 'createClient documentation'
    };

    expect(rankCandidates([featureCandidate, baseCandidate], docQuery).map(candidate => candidate.spanId)).toEqual(['span-doc-client']);

    const featureRoleQuery = normalizeQuery({ query: 'createClient documentation', targetRoles: ['feature_plan'] });
    expect(rankCandidates([featureCandidate], featureRoleQuery).map(candidate => candidate.spanId)).toEqual(['span-feature-node']);
  });
});
