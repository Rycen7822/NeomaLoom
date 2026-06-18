import {
  CONFIDENCE_SCORES,
  buildCrossReferenceEdges,
  confidenceForEvidence,
  shouldWriteCandidate,
  type LinkCandidate
} from '../../packages/core/src/linker/cross-reference-linker.js';
import { extractLinkCandidatesFromSpans } from '../../packages/core/src/linker/evidence-extractors.js';
import type { FileRole, SpanKind } from '../../packages/core/src/spans/enums.js';
import type { RepoSpan } from '../../packages/core/src/spans/types.js';

function span(input: {
  spanId: string;
  path: string;
  kind: SpanKind;
  role: FileRole;
  label: string;
  indexedText?: string;
  metadata?: Record<string, unknown>;
}): RepoSpan {
  return {
    spanId: input.spanId,
    path: input.path,
    kind: input.kind,
    role: input.role,
    label: input.label,
    startLine: 1,
    endLine: 1,
    language: 'text',
    headingPath: input.kind.startsWith('doc.') ? [input.label] : [],
    symbolPath: input.kind.startsWith('code.') ? [input.label] : [],
    stableLocator: {
      path: input.path,
      kind: input.kind,
      headingPath: [],
      blockOrdinal: 0,
      normalizedTextHash: input.spanId,
      nearbyHeadingHash: input.spanId
    },
    textHash: input.spanId,
    indexedText: input.indexedText ?? input.label,
    summary: input.label,
    metadata: input.metadata ?? {},
    source: 'test',
    updatedAt: 0
  };
}

describe('linker confidence', () => {
  it('uses the fixed confidence scores from the plan', () => {
    expect(CONFIDENCE_SCORES).toEqual({
      explicit_markdown_link: 1.0,
      exact_qualified_symbol_inline_code: 0.97,
      exact_config_cli_env_mention: 0.95,
      test_case_calls_source_symbol: 0.92,
      example_imports_or_calls_source_symbol: 0.9,
      rpg_feature_explicit_map: 0.88,
      exact_symbol_name_relevant_heading: 0.82,
      path_name_exact_relation: 0.75,
      call_neighborhood_overlap: 0.68,
      fuzzy_heading_symbol_relation: 0.6
    });
  });

  it('rejects candidates below 0.60', () => {
    expect(shouldWriteCandidate({ confidence: 0.59 })).toBe(false);
    expect(shouldWriteCandidate({ confidence: 0.6 })).toBe(true);
    expect(confidenceForEvidence('explicit_markdown_link')).toBe(1);
  });

  it('builds deterministic edges from accepted candidates only', () => {
    const candidates: LinkCandidate[] = [
      {
        sourceSpanId: 'doc:api',
        targetSpanId: 'code:createClient',
        relation: 'documents',
        evidenceKind: 'explicit_markdown_link',
        evidence: { path: 'docs/api/client.md' }
      },
      {
        sourceSpanId: 'doc:maybe',
        targetSpanId: 'code:maybe',
        relation: 'mentions',
        confidence: 0.59,
        evidenceKind: 'below_threshold',
        evidence: { reason: 'weak fuzzy match' }
      }
    ];

    const edges = buildCrossReferenceEdges(candidates);
    expect(edges).toEqual(buildCrossReferenceEdges([...candidates].reverse()));
    expect(edges).toEqual([
      {
        edgeId: expect.stringMatching(/^xref:[a-f0-9]{40}$/),
        sourceSpanId: 'doc:api',
        targetSpanId: 'code:createClient',
        relation: 'documents',
        confidence: 1,
        source: 'cross-reference-linker',
        evidence: { kind: 'explicit_markdown_link', path: 'docs/api/client.md' },
        updatedAt: 0
      }
    ]);
  });

  it('extracts deterministic cross-surface evidence candidates from spans', () => {
    const spans = [
      span({
        spanId: 'doc:link',
        path: 'docs/api/client.md',
        kind: 'doc.link',
        role: 'canonical_api_doc',
        label: 'Client source',
        metadata: { targetType: 'relative', path: '../../src/client.ts' }
      }),
      span({
        spanId: 'doc:inline',
        path: 'docs/api/client.md',
        kind: 'doc.paragraph',
        role: 'canonical_api_doc',
        label: 'Use createClient and --watch',
        metadata: { inlineCodeMentions: ['createClient', '--watch', 'NOEMALOOM_HOME'] }
      }),
      span({ spanId: 'code:createClient', path: 'src/client.ts', kind: 'code.function', role: 'source_file', label: 'createClient' }),
      span({
        spanId: 'config:watch',
        path: 'package.json',
        kind: 'config.entry',
        role: 'package_metadata',
        label: '--watch',
        metadata: { cliFlag: '--watch' }
      }),
      span({
        spanId: 'config:home',
        path: 'package.json',
        kind: 'config.entry',
        role: 'package_metadata',
        label: 'NOEMALOOM_HOME',
        metadata: { envVar: 'NOEMALOOM_HOME' }
      }),
      span({
        spanId: 'test:client',
        path: 'tests/client.test.ts',
        kind: 'test.case',
        role: 'test_file',
        label: 'creates client',
        indexedText: 'expect(createClient()).toBeDefined();'
      }),
      span({
        spanId: 'example:client',
        path: 'examples/client.ts',
        kind: 'example.block',
        role: 'example_doc',
        label: 'client example',
        indexedText: 'import { createClient } from "../src/client"; createClient();'
      }),
      span({
        spanId: 'feature:client',
        path: '.noemaloom/planning/features.json',
        kind: 'feature.node',
        role: 'feature_plan',
        label: 'Client API',
        metadata: { implementedBySpanIds: ['code:createClient'] }
      })
    ];

    const candidates = extractLinkCandidatesFromSpans(spans);
    const kinds = candidates.map(candidate => candidate.evidenceKind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'explicit_markdown_link',
        'exact_qualified_symbol_inline_code',
        'exact_config_cli_env_mention',
        'test_case_calls_source_symbol',
        'example_imports_or_calls_source_symbol',
        'rpg_feature_explicit_map'
      ])
    );
    expect(buildCrossReferenceEdges(candidates).every(edge => edge.confidence >= 0.6)).toBe(true);
  });
});
