import { z } from 'zod';

import { computeImpact } from '../../impact/impact.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

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

  return createEnvelope({
    ok: true,
    tool: 'nl_impact',
    projectRoot,
    graphRevision,
    graphState: 'ready',
    tokenBudget: {
      requested: 2500,
      used: Math.ceil(JSON.stringify(impact).length / 4),
      truncated: false
    },
    data: impact,
    nextActions: ['read impacted source, docs, config, tests, examples before editing']
  });
}
