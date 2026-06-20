import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type GraphState, type NoemaLoomEnvelope } from '../envelope.js';
import { RESPONSE_PROFILES, shapeEvidence, shapePlanChangeData, type ResponseProfile } from '../output-profile.js';
import {
  aggregateOk,
  combineEvidence,
  combineGraphRevision,
  combineGraphState,
  combineTokenBudget,
  combineWarnings,
  summarizeSteps
} from './aggregate-utils.js';
import { handleNlImpact } from './nl-impact.js';
import { handleNlLocate } from './nl-locate.js';
import { handleNlTrace } from './nl-trace.js';

type LocateData = {
  targets: unknown[];
  coveragePlan: unknown;
  normalizedQuery: unknown;
};

type ImpactData = {
  requiredVerification?: string[];
  requiredActions?: string[];
};

type PlanSkippedData = {
  status: 'skipped';
  reason: string;
  requiredActions: string[];
};

const PROMOTE_UNINDEXED_ACTION = 'call nl_refresh with target="paths" for unindexedCandidates before final impact claims';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSpanIndexError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('no such table: repo_spans') ||
    message.includes('no such table: repo_edges') ||
    message.includes('no such table: repo_spans_fts')
  );
}

function uniqueActions(actions: string[]): string[] {
  return [...new Set(actions)];
}

function locatePromotionActions(locateData: LocateData): string[] {
  return locateData.targets.some(target => typeof target === 'object' && target !== null && 'indexed' in target && target.indexed === false)
    ? [PROMOTE_UNINDEXED_ACTION]
    : [];
}

function skippedPlanEnvelope(input: {
  tool: 'nl_trace' | 'nl_impact';
  projectRoot: string;
  graphRevision: string | null;
  graphState: GraphState;
  warning: EnvelopeWarning;
  requiredActions: string[];
}): NoemaLoomEnvelope<PlanSkippedData> {
  return createEnvelope({
    ok: true,
    tool: input.tool,
    projectRoot: input.projectRoot,
    graphRevision: input.graphRevision,
    graphState: input.graphState,
    warnings: [input.warning],
    data: {
      status: 'skipped',
      reason: input.warning.message,
      requiredActions: input.requiredActions
    },
    nextActions: input.requiredActions
  });
}

export const nlPlanChangeInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.string().min(1),
    goal: z.string().optional(),
    targetType: z.enum(['auto', 'span', 'symbol', 'file', 'feature', 'config', 'doc']).default('auto'),
    targetRoles: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(30),
    direction: z.enum(['upstream', 'downstream', 'both']).default('both'),
    depth: z.number().int().min(0).max(5).default(2),
    relationTypes: z.array(z.string()).default(['all']),
    includeTrace: z.boolean().default(true),
    responseProfile: z.enum(RESPONSE_PROFILES).default('compact')
  })
  .passthrough();

export async function handleNlPlanChange(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlPlanChangeInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const goal = parsed.targetType === 'symbol'
    ? `\`${parsed.target}\` ${parsed.goal ?? parsed.target}`
    : parsed.targetType === 'file'
      ? `${parsed.target} ${parsed.goal ?? parsed.target}`
      : parsed.goal ?? parsed.target;
  const locate = await handleNlLocate({
    projectPath: parsed.projectPath,
    goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit
  });
  const locateData = locate.data as LocateData;
  const promotionActions = locatePromotionActions(locateData);
  const skippedActions = promotionActions.length > 0 ? promotionActions : ['call nl_refresh before final impact claims'];
  const trace = parsed.includeTrace
    ? await handleNlTrace({
        projectPath: parsed.projectPath,
        target: parsed.target,
        targetType: parsed.targetType,
        direction: parsed.direction,
        depth: parsed.depth,
        relationTypes: parsed.relationTypes
      }).catch(error => {
        if (!isMissingSpanIndexError(error)) {
          throw error;
        }
        return skippedPlanEnvelope({
          tool: 'nl_trace',
          projectRoot,
          graphRevision: locate.graphRevision,
          graphState: locate.graphState,
          warning: {
            code: 'plan_change_trace_skipped',
            severity: 'warning',
            message: `trace skipped because span index is unavailable: ${errorMessage(error)}`
          },
          requiredActions: skippedActions
        });
      })
    : null;
  const impact = await handleNlImpact({
    projectPath: parsed.projectPath,
    target: parsed.target,
    targetType: parsed.targetType,
    depth: parsed.depth
  }).catch(error => {
    if (!isMissingSpanIndexError(error)) {
      throw error;
    }
    return skippedPlanEnvelope({
      tool: 'nl_impact',
      projectRoot,
      graphRevision: locate.graphRevision,
      graphState: locate.graphState,
      warning: {
        code: 'plan_change_impact_skipped',
        severity: 'warning',
        message: `impact skipped because span index is unavailable: ${errorMessage(error)}`
      },
      requiredActions: skippedActions
    });
  });
  const envelopes = [locate, trace, impact];
  const traceData = trace?.data as (PlanSkippedData | Record<string, unknown> | undefined);
  const impactData = impact.data as (ImpactData & Partial<PlanSkippedData>);
  const traceSkipped = traceData && 'status' in traceData && traceData.status === 'skipped';
  const impactSkipped = impactData.status === 'skipped';
  const requiredActions = uniqueActions([
    ...promotionActions,
    ...(impactData.requiredActions ?? [])
  ]);

  const responseProfile = parsed.responseProfile as ResponseProfile;
  const data = {
    targets: locateData.targets,
    coveragePlan: locateData.coveragePlan,
    normalizedQuery: locateData.normalizedQuery,
    trace: traceSkipped ? null : trace?.data ?? null,
    impact: impactSkipped ? null : impact.data,
    requiredVerification: impactData.requiredVerification ?? [],
    requiredActions,
    steps: summarizeSteps(envelopes)
  };
  const evidence = combineEvidence(envelopes);

  return createEnvelope({
    ok: aggregateOk(envelopes),
    tool: 'nl_plan_change',
    projectRoot,
    graphRevision: combineGraphRevision(envelopes),
    graphState: combineGraphState(envelopes),
    tokenBudget: combineTokenBudget(envelopes),
    warnings: combineWarnings(envelopes),
    data: shapePlanChangeData(data, responseProfile) as Record<string, unknown>,
    evidence: shapeEvidence(evidence, responseProfile),
    nextActions: requiredActions.length > 0
      ? [...requiredActions, 'call nl_prepare_context when edit targets need ordering']
      : ['read impacted files with native tools', 'call nl_prepare_context when edit targets need ordering']
  });
}
