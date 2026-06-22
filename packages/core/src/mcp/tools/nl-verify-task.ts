import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import { shapeImpact } from '../output-profile.js';
import { estimateEnvelopeTokenBudget } from '../token-budget.js';
import { MAX_CHANGED_PATHS } from '../../files/bounded-changed-paths.js';
import { mergeRequiredVerification, requiredVerificationPaths } from '../../verifier/required-verification.js';
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
import { handleNlTrace } from './nl-trace.js';
import { handleNlVerifyCoverage } from './nl-verify-coverage.js';

type CoverageData = {
  status?: 'pass' | 'needs_attention' | 'fail' | string;
};

function verifyTaskNextActions(status: CoverageData['status'], graphState: NoemaLoomEnvelope['graphState']): string[] {
  if (status === 'pass') {
    return graphState === 'stale' ? ['call nl_refresh with target="changed" and mode="safe"'] : [];
  }
  return status === 'needs_attention'
    ? ['resolve reported coverage attention before refresh']
    : ['fix reported coverage gaps before refresh'];
}

export const nlVerifyTaskInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1).max(10_000),
    changedPaths: z.array(z.string()).max(MAX_CHANGED_PATHS).default([]),
    oldTerms: z.array(z.string()).max(MAX_CHANGED_PATHS).default([]),
    newTerms: z.array(z.string()).max(MAX_CHANGED_PATHS).default([]),
    oldTermPolicy: z.enum(['changed_paths', 'changed_paths_plus_advisory_docs', 'strict_global']).default('changed_paths_plus_advisory_docs'),
    target: z.string().optional(),
    targetType: z.enum(['auto', 'span', 'symbol', 'file', 'feature', 'config', 'doc']).default('auto'),
    depth: z.number().int().min(0).max(5).default(2),
    includeImpact: z.boolean().default(true),
    includeTrace: z.boolean().default(false)
  })
  .passthrough();

export async function handleNlVerifyTask(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlVerifyTaskInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const coverage = await handleNlVerifyCoverage({
    projectPath: parsed.projectPath,
    goal: parsed.goal,
    changedPaths: parsed.changedPaths,
    oldTerms: parsed.oldTerms,
    newTerms: parsed.newTerms,
    oldTermPolicy: parsed.oldTermPolicy
  });
  const impact =
    parsed.target && parsed.includeImpact
      ? await handleNlImpact({
          projectPath: parsed.projectPath,
          target: parsed.target,
          targetType: parsed.targetType,
          depth: parsed.depth
        })
      : null;
  const trace =
    parsed.target && parsed.includeTrace
      ? await handleNlTrace({
          projectPath: parsed.projectPath,
          target: parsed.target,
          direction: 'both',
          depth: parsed.depth,
          relationTypes: ['all']
        })
      : null;
  const envelopes = [coverage, impact, trace];
  const coverageData = coverage.data as CoverageData;
  const impactData = impact?.data as ({ requiredVerification?: string[] } | null | undefined);
  const requiredVerificationDetails = mergeRequiredVerification({
    impactRequiredVerification: impactData?.requiredVerification,
    coverage: coverage.data
  });

  let data: Record<string, unknown> = {
    status: coverageData.status ?? 'unknown',
    coverage: coverage.data,
    impact: impact?.data ?? null,
    trace: trace?.data ?? null,
    requiredVerification: requiredVerificationPaths(requiredVerificationDetails),
    requiredVerificationDetails,
    steps: summarizeSteps(envelopes)
  };
  const nextActions = verifyTaskNextActions(coverageData.status, coverage.graphState);
  let tokenBudget = combineTokenBudget(envelopes);
  let warnings = combineWarnings(envelopes);
  const finalBudget = estimateEnvelopeTokenBudget({ requested: 2500, data, nextActions });
  if (finalBudget.tokenBudget.truncated) {
    data = {
      ...data,
      impact: impact?.data ? shapeImpact(impact.data, 'compact') : null
    };
    const shapedBudget = estimateEnvelopeTokenBudget({ requested: 2500, data, nextActions });
    tokenBudget = { ...shapedBudget.tokenBudget, truncated: true };
    warnings = [...warnings, ...finalBudget.warnings, ...shapedBudget.warnings];
  }

  return createEnvelope({
    ok: aggregateOk(envelopes),
    tool: 'nl_verify_task',
    projectRoot,
    graphRevision: combineGraphRevision(envelopes),
    graphState: combineGraphState(envelopes),
    tokenBudget,
    warnings,
    data,
    evidence: combineEvidence(envelopes),
    nextActions
  });
}
