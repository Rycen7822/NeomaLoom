import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import {
  combineEvidence,
  combineWarnings
} from './aggregate-utils.js';
import { buildContextDataFromLocated } from './nl-context.js';
import { runLocator } from './nl-locate.js';
import { handleNlReadSpan } from './nl-read-span.js';

type LocateData = {
  targets: Array<{
    spanId: string;
    path: string;
    kind: string;
    role: string;
    label: string;
    startLine: number;
    endLine: number;
    headingPath: string[];
    score: number;
    scoreBreakdown: unknown;
    evidence: Array<Record<string, unknown>>;
    linkedSpans: Array<Record<string, unknown>>;
    decision: string;
    indexed?: boolean;
    promotionAction?: { target: 'paths'; paths: string[]; reason: string };
  }>;
  unindexedCandidates?: Array<{ path: string; promotionAction?: { target: 'paths'; paths: string[]; reason: string } }>;
  coverage?: unknown;
  coveragePlan: unknown;
  normalizedQuery: unknown;
};

export const nlPrepareContextInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    scope: z.string().optional(),
    targetRoles: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(20),
    budget: z.number().int().positive().max(10000).default(2400),
    includeSnippets: z.boolean().default(false),
    includeQueryPreview: z.boolean().default(true),
    readTopSpans: z.boolean().default(false),
    maxReadSpans: z.number().int().min(0).max(10).default(3),
    contextLines: z.number().int().min(0).max(80).default(10)
  })
  .passthrough();

export async function handleNlPrepareContext(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlPrepareContextInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const goal = parsed.scope ? `${parsed.scope} ${parsed.goal}` : parsed.goal;

  const located = await runLocator({
    projectRoot,
    goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit,
    budget: parsed.budget
  });
  const locateData: LocateData = {
    targets: located.targets,
    unindexedCandidates: located.targets.filter(target => target.indexed === false),
    coverage: located.coverage,
    coveragePlan: located.coveragePlan,
    normalizedQuery: located.normalizedQuery
  };
  const contextData = await buildContextDataFromLocated({
    projectRoot,
    located,
    includeSnippets: parsed.includeSnippets
  });
  const readTargets = parsed.readTopSpans
    ? locateData.targets
      .filter(target => target.indexed !== false && ['must_edit', 'maybe_edit'].includes(target.decision))
        .slice(0, parsed.maxReadSpans)
    : [];
  const readResults = await Promise.all(
    readTargets.map(target =>
      handleNlReadSpan({
        projectPath: parsed.projectPath,
        spanId: target.spanId,
        contextLines: parsed.contextLines
      })
    )
  );
  const readWarnings = combineWarnings(readResults);
  const unindexedCandidates = locateData.unindexedCandidates ?? locateData.targets.filter(target => target.indexed === false);
  const ok = readResults.every(result => result.ok !== false);
  const graphState = readResults.some(result => result.graphState === 'stale') ? 'stale' : located.graphState;
  const nextActions = unindexedCandidates.length > 0
    ? ['call nl_refresh with target="paths" for unindexedCandidates', 'rerun nl_prepare_context after promotion']
    : ok && graphState === 'ready' && locateData.targets.length > 0
      ? ['edit with native agent tools', 'call nl_verify_task after edits']
      : ['call nl_refresh before editing', 'inspect nl_status warnings'];
  const queryPreview = parsed.includeQueryPreview
    ? locateData.targets.slice(0, Math.min(parsed.limit, 5)).map(target => ({
        spanId: target.spanId,
        path: target.path,
        kind: target.kind,
        role: target.role,
        label: target.label,
        startLine: target.startLine,
        endLine: target.endLine,
        headingPath: target.headingPath,
        score: target.score,
        scoreBreakdown: target.scoreBreakdown,
        evidence: target.evidence,
        linkedSpans: target.linkedSpans,
        indexed: target.indexed ?? true,
        promotionAction: target.promotionAction
      }))
    : [];

  return createEnvelope({
    ok,
    tool: 'nl_prepare_context',
    projectRoot,
    graphRevision: located.graphRevision,
    graphState,
    tokenBudget: located.tokenBudget,
    warnings: [...located.warnings, ...readWarnings],
    data: {
      queryPreview,
      targets: locateData.targets,
      unindexedCandidates,
      coverage: locateData.coverage,
      coveragePlan: locateData.coveragePlan,
      normalizedQuery: locateData.normalizedQuery,
      context: contextData,
      readSpans: readResults.map(result => result.data),
      steps: ['nl_locate', 'nl_context_from_located', ...readResults.map(result => result.tool)]
    },
    evidence: [...located.targets.flatMap(target => target.evidence), ...combineEvidence(readResults)],
    nextActions
  });
}
