import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import {
  aggregateOk,
  combineEvidence,
  combineGraphRevision,
  combineGraphState,
  combineTokenBudget,
  combineWarnings,
  summarizeSteps
} from './aggregate-utils.js';
import { handleNlContext } from './nl-context.js';
import { handleNlLocate } from './nl-locate.js';
import { handleNlQuery } from './nl-query.js';
import { handleNlReadSpan } from './nl-read-span.js';

type LocateData = {
  targets: Array<{
    spanId: string;
    path: string;
    decision: string;
    indexed?: boolean;
    promotionAction?: { target: 'paths'; paths: string[]; reason: string };
  }>;
  unindexedCandidates?: Array<{ path: string; promotionAction?: { target: 'paths'; paths: string[]; reason: string } }>;
  coverage?: unknown;
  coveragePlan: unknown;
  normalizedQuery: unknown;
};

type QueryData = {
  results: unknown[];
};

export const nlPrepareContextInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    scope: z.string().optional(),
    targetRoles: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(20),
    budget: z.number().int().positive().max(10000).default(2048),
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

  const query = parsed.includeQueryPreview
    ? await handleNlQuery({
        projectPath: parsed.projectPath,
        query: parsed.goal,
        scope: parsed.scope,
        limit: Math.min(parsed.limit, 5)
      })
    : null;
  const locate = await handleNlLocate({
    projectPath: parsed.projectPath,
    goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit
  });
  const context = await handleNlContext({
    projectPath: parsed.projectPath,
    goal,
    budget: parsed.budget,
    includeSnippets: parsed.includeSnippets
  });
  const locateData = locate.data as LocateData;
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
  const envelopes = [query, locate, context, ...readResults];
  const queryData = query?.data as QueryData | undefined;
  const ok = aggregateOk(envelopes);
  const graphState = combineGraphState(envelopes);
  const unindexedCandidates = locateData.unindexedCandidates ?? locateData.targets.filter(target => target.indexed === false);
  const nextActions = unindexedCandidates.length > 0
    ? ['call nl_refresh with target="paths" for unindexedCandidates', 'rerun nl_prepare_context after promotion']
    : ok && graphState === 'ready' && locateData.targets.length > 0
      ? ['edit with native agent tools', 'call nl_verify_task after edits']
      : ['call nl_refresh before editing', 'inspect nl_status warnings'];

  return createEnvelope({
    ok,
    tool: 'nl_prepare_context',
    projectRoot,
    graphRevision: combineGraphRevision(envelopes),
    graphState,
    tokenBudget: combineTokenBudget(envelopes),
    warnings: combineWarnings(envelopes),
    data: {
      queryPreview: queryData?.results ?? [],
      targets: locateData.targets,
      unindexedCandidates,
      coverage: locateData.coverage,
      coveragePlan: locateData.coveragePlan,
      normalizedQuery: locateData.normalizedQuery,
      context: context.data,
      readSpans: readResults.map(result => result.data),
      steps: summarizeSteps(envelopes)
    },
    evidence: combineEvidence(envelopes),
    nextActions
  });
}
