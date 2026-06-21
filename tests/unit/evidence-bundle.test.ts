import { buildEvidenceBundle } from '../../packages/core/src/locator/evidence-bundle.js';

describe('EvidenceBundle', () => {
  it('keeps route, evidence, linked span, boundary, and redaction summaries compact', () => {
    const bundle = buildEvidenceBundle({
      sourcePlanSources: ['code_symbol_name_signature', 'fts_lexical', 'fts_lexical'],
      evidence: [{ kind: 'symbol_match' }, { kind: 'direct_text_match' }, { kind: 'extra' }],
      linkedSpans: [{ spanId: 'a', confidence: 0.9 }, { spanId: 'b', confidence: 0.6 }],
      boundary: { risk: 'low', stale: false, warnings: ['note'] },
      metadata: { redactedAtIndexWrite: true, redactedKinds: ['api_key'] }
    }, { maxEvidence: 2, maxLinkedSpans: 1 });

    expect(bundle).toEqual({
      routes: ['code_symbol_name_signature', 'fts_lexical'],
      evidencePreview: [{ kind: 'symbol_match' }, { kind: 'direct_text_match' }],
      linkedSpanPreview: [{ spanId: 'a', confidence: 0.9 }],
      boundary: { risk: 'low', stale: false, warningCount: 1 },
      redaction: { redacted: true, kinds: ['api_key'] }
    });
  });
});
