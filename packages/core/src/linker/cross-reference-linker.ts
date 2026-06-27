
import type { EdgeRelation } from '../spans/enums.js';
import type { RepoEdge } from '../spans/types.js';
import {
  CONFIDENCE_SCORES,
  confidenceForEvidence,
  shouldWriteCandidate,
  type EvidenceKind
} from './confidence.js';
import { sha1 } from '../shared/hash.js';

export { CONFIDENCE_SCORES, confidenceForEvidence, shouldWriteCandidate };

export type LinkCandidate = {
  sourceSpanId: string;
  targetSpanId: string;
  relation: EdgeRelation;
  evidenceKind: EvidenceKind;
  evidence: Record<string, unknown>;
  confidence?: number;
};

function edgeId(candidate: LinkCandidate): string {
  return `xref:${sha1(
    JSON.stringify({
      sourceSpanId: candidate.sourceSpanId,
      targetSpanId: candidate.targetSpanId,
      relation: candidate.relation,
      evidenceKind: candidate.evidenceKind
    })
  )}`;
}

export function buildCrossReferenceEdges(candidates: LinkCandidate[]): RepoEdge[] {
  return [...candidates]
    .map(candidate => ({
      candidate,
      confidence: candidate.confidence ?? confidenceForEvidence(candidate.evidenceKind)
    }))
    .filter(item => shouldWriteCandidate({ confidence: item.confidence }))
    .sort((left, right) =>
      [
        left.candidate.sourceSpanId.localeCompare(right.candidate.sourceSpanId),
        left.candidate.targetSpanId.localeCompare(right.candidate.targetSpanId),
        left.candidate.relation.localeCompare(right.candidate.relation)
      ].find(result => result !== 0) ?? 0
    )
    .map(({ candidate, confidence }) => ({
      edgeId: edgeId(candidate),
      sourceSpanId: candidate.sourceSpanId,
      targetSpanId: candidate.targetSpanId,
      relation: candidate.relation,
      confidence,
      source: 'cross-reference-linker',
      evidence: {
        kind: candidate.evidenceKind,
        ...candidate.evidence
      },
      updatedAt: 0
    }));
}
