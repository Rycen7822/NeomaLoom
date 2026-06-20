import type { GraphState, NoemaLoomEnvelope, TokenBudget } from '../envelope.js';

const graphStatePriority: GraphState[] = ['error', 'stale', 'partial', 'empty', 'ready'];

export function aggregateOk(envelopes: Array<NoemaLoomEnvelope | null | undefined>): boolean {
  return envelopes.filter(Boolean).every(envelope => envelope?.ok);
}

export function combineGraphState(envelopes: Array<NoemaLoomEnvelope | null | undefined>): GraphState {
  const states = envelopes.filter(Boolean).map(envelope => envelope?.graphState ?? 'empty');
  return graphStatePriority.find(state => states.includes(state)) ?? 'ready';
}

export function combineGraphRevision(envelopes: Array<NoemaLoomEnvelope | null | undefined>): string | null {
  return [...envelopes].reverse().find(envelope => envelope?.graphRevision)?.graphRevision ?? null;
}

export function combineTokenBudget(envelopes: Array<NoemaLoomEnvelope | null | undefined>): TokenBudget {
  return envelopes.filter(Boolean).reduce<TokenBudget>(
    (combined, envelope) => ({
      requested: combined.requested + (envelope?.tokenBudget.requested ?? 0),
      used: combined.used + (envelope?.tokenBudget.used ?? 0),
      truncated: combined.truncated || (envelope?.tokenBudget.truncated ?? false)
    }),
    { requested: 0, used: 0, truncated: false }
  );
}

export function combineWarnings(envelopes: Array<NoemaLoomEnvelope | null | undefined>) {
  return envelopes.filter(Boolean).flatMap(envelope => envelope?.warnings ?? []);
}

const MAX_COMBINED_EVIDENCE = 80;

export function combineEvidence(envelopes: Array<NoemaLoomEnvelope | null | undefined>): unknown[] {
  return envelopes.filter(Boolean).flatMap(envelope => envelope?.evidence ?? []).slice(0, MAX_COMBINED_EVIDENCE);
}

export function summarizeSteps(envelopes: Array<NoemaLoomEnvelope | null | undefined>) {
  return envelopes.filter(Boolean).map(envelope => ({
    tool: envelope?.tool,
    ok: envelope?.ok,
    graphState: envelope?.graphState,
    warnings: envelope?.warnings.length ?? 0,
    tokenBudget: envelope?.tokenBudget,
    nextActions: envelope?.nextActions ?? []
  }));
}
