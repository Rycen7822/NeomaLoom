import { z } from 'zod';

import { buildCoveragePlan, type CoveragePlan } from '../../locator/coverage-plan.js';
import { generateCandidates } from '../../locator/candidate-generation.js';
import { decideCandidate } from '../../locator/decision.js';
import { rankCandidates, type RankedCandidate, type LocatorDecision } from '../../locator/ranking.js';
import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type GraphState, type NoemaLoomEnvelope, type TokenBudget } from '../envelope.js';
import { applyLocatorTokenBudget } from '../token-budget.js';

export const nlLocateInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    targetRoles: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(20)
  })
  .passthrough();

export type LocatorTarget = {
  spanId: string;
  decision: LocatorDecision;
  path: string;
  kind: string;
  role: string;
  label: string;
  startLine: number;
  endLine: number;
  recommendedReadRange: { startLine: number; endLine: number };
  headingPath: string[];
  confidence: number;
  score: number;
  scoreBreakdown: RankedCandidate['scoreBreakdown'];
  reason: string;
  linkedSpans: RankedCandidate['linkedSpans'];
  evidence: RankedCandidate['evidence'];
  editRisk: 'low' | 'medium' | 'high';
  sourcePlanSources: string[];
  estimatedTokens: number;
  indexed?: boolean;
  promotionAction?: { target: 'paths'; paths: string[]; reason: string };
  editBoundary?: unknown;
};

export type LocatorRunResult = {
  projectRoot: string;
  graphRevision: string | null;
  graphState: GraphState;
  targets: LocatorTarget[];
  coveragePlan: CoveragePlan;
  coverage: unknown;
  normalizedQuery: unknown;
  warnings: EnvelopeWarning[];
  tokenBudget: TokenBudget;
};

function targetFromRanked(candidate: RankedCandidate): LocatorTarget {
  const decision = decideCandidate(candidate);
  const evidence = candidate.evidence.slice(0, 12);
  const linkedSpans = candidate.linkedSpans.slice(0, 20);
  const target = {
    spanId: candidate.spanId,
    decision: decision.decision,
    path: candidate.path,
    kind: String(candidate.kind),
    role: String(candidate.role),
    label: candidate.label,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    recommendedReadRange: {
      startLine: Math.max(1, candidate.startLine - 20),
      endLine: candidate.endLine + 20
    },
    headingPath: candidate.headingPath,
    confidence: decision.confidence,
    score: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    reason: decision.reason,
    linkedSpans,
    evidence,
    editRisk: decision.editRisk,
    sourcePlanSources: candidate.sourcePlanSources,
    indexed: candidate.indexed ?? true,
    promotionAction: candidate.promotionAction,
    editBoundary: candidate.metadata?.editBoundary,
    estimatedTokens: 30 + evidence.length * 8 + linkedSpans.length * 4
  };
  return target;
}

export async function runLocator(input: {
  projectRoot: string;
  goal: string;
  targetRoles?: string[];
  limit?: number;
  budget?: number;
}): Promise<LocatorRunResult> {
  const includeGeneratedVendor = (input.targetRoles ?? []).some(role => ['generated_file', 'vendor_file'].includes(role));
  const generated = await generateCandidates({
    projectRoot: input.projectRoot,
    query: input.goal,
    targetRoles: input.targetRoles,
    limit: Math.max(input.limit ?? 20, 50),
    includeGeneratedVendor
  });
  const ranked = rankCandidates(generated.candidates, generated.normalizedQuery, { includeGeneratedVendor });
  const coveragePlan = buildCoveragePlan({
    query: generated.normalizedQuery,
    targets: ranked,
    requestedRoles: input.targetRoles
  });
  const targets = ranked.slice(0, input.limit ?? 20).map(targetFromRanked);
  const budgeted = applyLocatorTokenBudget({
    requested: input.budget ?? 2400,
    targets,
    warnings: [...generated.warnings, ...coveragePlan.warnings]
  });

  return {
    projectRoot: input.projectRoot,
    graphRevision: generated.graphRevision,
    graphState: generated.graphState,
    targets: budgeted.targets,
    coveragePlan,
    coverage: generated.coverage,
    normalizedQuery: generated.normalizedQuery,
    warnings: budgeted.warnings,
    tokenBudget: budgeted.tokenBudget
  };
}

export async function handleNlLocate(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlLocateInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const located = await runLocator({
    projectRoot,
    goal: parsed.goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit,
    budget: 2400
  });

  return createEnvelope({
    ok: true,
    tool: 'nl_locate',
    projectRoot,
    graphRevision: located.graphRevision,
    graphState: located.graphState,
    tokenBudget: located.tokenBudget,
    warnings: located.warnings,
    data: {
      targets: located.targets,
      unindexedCandidates: located.targets.filter(target => target.indexed === false),
      coverage: located.coverage,
      coveragePlan: located.coveragePlan,
      normalizedQuery: located.normalizedQuery
    },
    evidence: located.targets.flatMap(target => target.evidence),
    nextActions: located.targets.some(target => target.indexed === false)
      ? ['call nl_refresh with target="paths" for unindexedCandidates before span reads', 'rerun nl_prepare_context after promotion']
      : ['read must_edit targets with nl_read_span before editing']
  });
}
