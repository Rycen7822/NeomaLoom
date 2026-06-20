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
    includeTrace: z.boolean().default(true)
  })
  .passthrough();

export async function handleNlPlanChange(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlPlanChangeInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const goal = parsed.targetType === 'file'
    ? `${parsed.target} ${parsed.goal ?? parsed.target}`
    : parsed.goal ?? parsed.target;
  const locate = await handleNlLocate({
    projectPath: parsed.projectPath,
    goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit
  });
  const trace = parsed.includeTrace
    ? await handleNlTrace({
        projectPath: parsed.projectPath,
        target: parsed.target,
        targetType: parsed.targetType,
        direction: parsed.direction,
        depth: parsed.depth,
        relationTypes: parsed.relationTypes
      })
    : null;
  const impact = await handleNlImpact({
    projectPath: parsed.projectPath,
    target: parsed.target,
    targetType: parsed.targetType,
    depth: parsed.depth
  });
  const envelopes = [locate, trace, impact];
  const locateData = locate.data as LocateData;
  const impactData = impact.data as ImpactData;

  return createEnvelope({
    ok: aggregateOk(envelopes),
    tool: 'nl_plan_change',
    projectRoot,
    graphRevision: combineGraphRevision(envelopes),
    graphState: combineGraphState(envelopes),
    tokenBudget: combineTokenBudget(envelopes),
    warnings: combineWarnings(envelopes),
    data: {
      targets: locateData.targets,
      coveragePlan: locateData.coveragePlan,
      normalizedQuery: locateData.normalizedQuery,
      trace: trace?.data ?? null,
      impact: impact.data,
      requiredVerification: impactData.requiredVerification ?? [],
      requiredActions: impactData.requiredActions ?? [],
      steps: summarizeSteps(envelopes)
    },
    evidence: combineEvidence(envelopes),
    nextActions: (impactData.requiredActions?.length ?? 0) > 0
      ? [...(impactData.requiredActions ?? []), 'call nl_prepare_context when edit targets need ordering']
      : ['read impacted files with native tools', 'call nl_prepare_context when edit targets need ordering']
  });
}
