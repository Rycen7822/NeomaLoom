import type { LocatorDecision, RankedCandidate } from './ranking.js';

export type CandidateDecision = {
  decision: LocatorDecision;
  confidence: number;
  reason: string;
  editRisk: 'low' | 'medium' | 'high';
};

export function decideCandidate(candidate: RankedCandidate): CandidateDecision {
  const confidence = Math.max(0, Math.min(1, candidate.score / 100));
  const editRisk = candidate.boundary.risk;

  if (candidate.boundary.risk === 'high' || candidate.boundary.stale) {
    return {
      decision: 'inspect_only',
      confidence,
      reason: 'boundary risk high or index stale',
      editRisk
    };
  }

  if (candidate.sourcePlanSources.includes('old_term_sweep')) {
    return {
      decision: 'verify_only',
      confidence,
      reason: 'contains oldTerm sweep hit',
      editRisk
    };
  }

  if (candidate.role === 'test_file' || String(candidate.kind).startsWith('test.')) {
    return {
      decision: 'verify_only',
      confidence,
      reason: 'test target must be verified after edit',
      editRisk
    };
  }

  if (candidate.score >= 85 && candidate.evidence.length >= 1) {
    return {
      decision: 'must_edit',
      confidence,
      reason: 'score >= 85 with direct evidence',
      editRisk
    };
  }

  if (candidate.score >= 70) {
    return {
      decision: 'maybe_edit',
      confidence,
      reason: '70 <= score < 85',
      editRisk
    };
  }

  return {
    decision: 'inspect_only',
    confidence,
    reason: candidate.score >= 50 ? '50 <= score < 70' : 'score < 50',
    editRisk
  };
}
