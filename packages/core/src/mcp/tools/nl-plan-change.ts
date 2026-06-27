import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type GraphState, type NoemaLoomEnvelope } from '../envelope.js';
import { writeMcpDebugArtifact } from '../debug-artifact.js';
import { mergeRequiredVerification, requiredVerificationPaths } from '../../verifier/required-verification.js';
import { RESPONSE_PROFILES, shapeEvidence, shapePlanChangeData, trimAgentDataForBudget, type ResponseProfile } from '../output-profile.js';
import { estimateEnvelopeTokenBudget } from '../token-budget.js';
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
  let impact = await handleNlImpact({
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
  const rawImpactData = impact.data as (ImpactData & { impactCoverage?: string });
  if (
    rawImpactData.impactCoverage === 'none' &&
    (rawImpactData.requiredActions ?? []).includes('run nl_refresh before impact tracing')
  ) {
    impact = skippedPlanEnvelope({
      tool: 'nl_impact',
      projectRoot,
      graphRevision: locate.graphRevision,
      graphState: locate.graphState,
      warning: {
        code: 'plan_change_impact_skipped',
        severity: 'warning',
        message: 'impact skipped because span index is unavailable; promote indexed paths before final impact claims'
      },
      requiredActions: skippedActions
    });
  }
  const envelopes = [locate, trace, impact];
  const traceData = trace?.data as (PlanSkippedData | Record<string, unknown> | undefined);
  const impactData = impact.data as (ImpactData & Partial<PlanSkippedData>);
  const traceSkipped = traceData && 'status' in traceData && traceData.status === 'skipped';
  const impactSkipped = impactData.status === 'skipped';
  const requiredActions = uniqueActions([
    ...promotionActions,
    ...(impactData.requiredActions ?? [])
  ]);
  const requiredVerificationDetails = mergeRequiredVerification({
    impactRequiredVerification: impactData.requiredVerification,
    coveragePlan: locateData.coveragePlan
  });

  const responseProfile = parsed.responseProfile as ResponseProfile;
  const data = {
    targets: locateData.targets,
    coveragePlan: locateData.coveragePlan,
    normalizedQuery: locateData.normalizedQuery,
    trace: traceSkipped ? null : trace?.data ?? null,
    impact: impactSkipped ? null : impact.data,
    requiredVerification: requiredVerificationPaths(requiredVerificationDetails),
    requiredVerificationDetails,
    requiredActions,
    steps: summarizeSteps(envelopes)
  };
  const evidence = combineEvidence(envelopes);
  let shapedData = shapePlanChangeData(data, responseProfile) as Record<string, unknown>;
  const shapedEvidence = shapeEvidence(evidence, responseProfile);
  const nextActions = requiredActions.length > 0
    ? [...requiredActions, 'call nl_prepare_context when edit targets need ordering']
    : ['read impacted files with native tools', 'call nl_prepare_context when edit targets need ordering'];
  const combinedBudget = combineTokenBudget(envelopes);
  const combinedWarnings = combineWarnings(envelopes);
  const artifactWarnings: EnvelopeWarning[] = [];
  if (responseProfile !== 'debug') {
    try {
      shapedData = {
        ...shapedData,
        debugArtifact: await writeMcpDebugArtifact({
          projectRoot,
          tool: 'nl_plan_change',
          responseProfile,
          data,
          evidence,
          warnings: combinedWarnings,
          nextActions
        })
      };
    } catch (error) {
      artifactWarnings.push({
        code: 'debug_artifact_write_failed',
        severity: 'warning',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  let budgetWarnings: EnvelopeWarning[] = [...combinedWarnings, ...artifactWarnings];
  let finalizedBudget = estimateEnvelopeTokenBudget({
    requested: combinedBudget.requested,
    data: shapedData,
    evidence: shapedEvidence,
    warnings: budgetWarnings,
    nextActions,
    truncated: combinedBudget.truncated
  });
  if (responseProfile === 'agent' && finalizedBudget.tokenBudget.used > finalizedBudget.tokenBudget.requested) {
    shapedData = trimAgentDataForBudget(shapedData) as Record<string, unknown>;
    budgetWarnings = [
      ...budgetWarnings,
      {
        code: 'output_trimmed_to_budget',
        severity: 'info',
        message: 'Agent output exceeded the requested budget after first-pass shaping; non-critical arrays/previews were trimmed while preserving targets, required verification/actions, and debugArtifact.'
      }
    ];
    finalizedBudget = estimateEnvelopeTokenBudget({
      requested: combinedBudget.requested,
      data: shapedData,
      evidence: shapedEvidence,
      warnings: budgetWarnings,
      nextActions,
      truncated: true
    });
  }

  return createEnvelope({
    ok: aggregateOk(envelopes),
    tool: 'nl_plan_change',
    projectRoot,
    graphRevision: combineGraphRevision(envelopes),
    graphState: combineGraphState(envelopes),
    tokenBudget: finalizedBudget.tokenBudget,
    warnings: finalizedBudget.warnings,
    data: shapedData,
    evidence: shapedEvidence,
    nextActions
  });
}
