export type EvidenceBundleInput = {
  sourcePlanSources?: string[];
  evidence?: Array<Record<string, unknown>>;
  linkedSpans?: Array<{ spanId: string; confidence: number; relation?: string }>;
  boundary?: { risk?: string; stale?: boolean; warnings?: unknown[] };
  metadata?: Record<string, unknown>;
};

export type EvidenceBundle = {
  routes: string[];
  evidencePreview: Array<Record<string, unknown>>;
  linkedSpanPreview: Array<{ spanId: string; confidence: number; relation?: string }>;
  boundary: { risk?: string; stale?: boolean; warningCount: number };
  redaction?: { redacted: boolean; kinds: string[] };
};

function uniqueStrings(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))] : [];
}

export function buildEvidenceBundle(input: EvidenceBundleInput, options: { maxEvidence?: number; maxLinkedSpans?: number } = {}): EvidenceBundle {
  const redactedKinds = uniqueStrings(input.metadata?.redactedKinds);
  const boundary = input.boundary ?? {};
  return {
    routes: uniqueStrings(input.sourcePlanSources),
    evidencePreview: (input.evidence ?? []).slice(0, options.maxEvidence ?? 3),
    linkedSpanPreview: (input.linkedSpans ?? []).slice(0, options.maxLinkedSpans ?? 3),
    boundary: {
      risk: boundary.risk,
      stale: boundary.stale,
      warningCount: Array.isArray(boundary.warnings) ? boundary.warnings.length : 0
    },
    ...(input.metadata?.redactedAtIndexWrite === true ? { redaction: { redacted: true, kinds: redactedKinds } } : {})
  };
}
