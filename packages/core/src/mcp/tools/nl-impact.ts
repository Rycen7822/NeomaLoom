import { z } from 'zod';

import { computeImpact } from '../../impact/impact.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import { shapeImpact } from '../output-profile.js';
import { estimateEnvelopeTokenBudget } from '../token-budget.js';

export const nlImpactInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.string().min(1),
    targetType: z.enum(['auto', 'span', 'symbol', 'file', 'feature', 'config', 'doc']).default('auto'),
    depth: z.number().int().min(0).max(5).default(2)
  })
  .passthrough();

export async function handleNlImpact(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlImpactInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const impact = computeImpact({
    projectRoot,
    target: parsed.target,
    targetType: parsed.targetType,
    depth: parsed.depth
  });

  const nextActions = impact.requiredActions.length > 0
    ? [...impact.requiredActions, 'read impacted source, docs, config, tests, examples before editing']
    : ['read impacted source, docs, config, tests, examples before editing'];
  let data: Record<string, unknown> = impact as unknown as Record<string, unknown>;
  let budget = estimateEnvelopeTokenBudget({
    requested: 2500,
    data,
    nextActions
  });
  if (budget.tokenBudget.truncated) {
    data = shapeImpact(impact, 'compact') as Record<string, unknown>;
    const shapedBudget = estimateEnvelopeTokenBudget({ requested: 2500, data, nextActions });
    budget = {
      tokenBudget: { ...shapedBudget.tokenBudget, truncated: true },
      warnings: [...budget.warnings, ...shapedBudget.warnings]
    };
  }

  return createEnvelope({
    ok: true,
    tool: 'nl_impact',
    projectRoot,
    graphRevision,
    graphState: impact.impactCoverage === 'full' ? 'ready' : 'partial',
    tokenBudget: budget.tokenBudget,
    warnings: budget.warnings,
    data,
    nextActions
  });
}
