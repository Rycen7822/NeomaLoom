import { z } from 'zod';

import { verifyCoverage } from '../../verifier/coverage-verifier.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

export const nlVerifyCoverageInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    changedPaths: z.array(z.string()).default([]),
    oldTerms: z.array(z.string()).default([]),
    newTerms: z.array(z.string()).default([])
  })
  .passthrough();

export async function handleNlVerifyCoverage(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlVerifyCoverageInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const result = await verifyCoverage({
    projectRoot,
    goal: parsed.goal,
    changedPaths: parsed.changedPaths,
    oldTerms: parsed.oldTerms,
    newTerms: parsed.newTerms
  });

  return createEnvelope({
    ok: true,
    tool: 'nl_verify_coverage',
    projectRoot,
    graphRevision,
    graphState: parsed.changedPaths.length > 0 ? 'stale' : 'ready',
    tokenBudget: {
      requested: 2500,
      used: Math.ceil(JSON.stringify(result).length / 4),
      truncated: false
    },
    data: result,
    nextActions: result.status === 'pass' ? ['nl_refresh(target="changed", mode="safe")'] : ['fix reported coverage gaps before refresh']
  });
}
