import { z } from 'zod';

import { traceGraph } from '../../impact/trace.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

export const nlTraceInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.string().min(1),
    direction: z.enum(['upstream', 'downstream', 'both']).default('both'),
    depth: z.number().int().min(0).max(5).default(2),
    relationTypes: z.array(z.string()).default(['all'])
  })
  .passthrough();

export async function handleNlTrace(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlTraceInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const graph = traceGraph({
    projectRoot,
    target: parsed.target,
    direction: parsed.direction,
    depth: parsed.depth,
    relationTypes: parsed.relationTypes
  });

  return createEnvelope({
    ok: true,
    tool: 'nl_trace',
    projectRoot,
    graphRevision,
    graphState: graph.nodes.length > 0 ? 'ready' : 'partial',
    tokenBudget: {
      requested: 2500,
      used: Math.ceil(JSON.stringify(graph).length / 4),
      truncated: false
    },
    data: graph,
    evidence: graph.edges.map(edge => edge.evidence),
    nextActions: ['use nl_impact for grouped verification planning']
  });
}
