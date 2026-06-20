import { z } from 'zod';

import { traceGraph, type TraceGraph, type TraceNode, type TraceEdge } from '../../impact/trace.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

const TRACE_TOKEN_BUDGET = 2500;
const MAX_TRACE_OUTPUT_NODES = 24;
const MAX_TRACE_OUTPUT_EDGES = 40;

type CappedTraceGraph = TraceGraph & {
  omittedNodes: number;
  omittedEdges: number;
};

function uniqueNodes(nodes: TraceNode[]): TraceNode[] {
  const seen = new Set<string>();
  const out: TraceNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.spanId)) continue;
    seen.add(node.spanId);
    out.push(node);
  }
  return out;
}

function capTraceGraph(graph: TraceGraph): CappedTraceGraph {
  const seedIds = new Set(graph.seedSpanIds);
  const seedNodes = graph.seedSpanIds
    .map(seedId => graph.nodes.find(node => node.spanId === seedId))
    .filter((node): node is TraceNode => Boolean(node));
  const orderedNodes = uniqueNodes([
    ...seedNodes,
    ...graph.nodes.filter(node => !seedIds.has(node.spanId))
  ]).slice(0, MAX_TRACE_OUTPUT_NODES);
  const keptIds = new Set(orderedNodes.map(node => node.spanId));
  const orderedEdges: TraceEdge[] = graph.edges
    .filter(edge => keptIds.has(edge.sourceSpanId) && keptIds.has(edge.targetSpanId))
    .slice(0, MAX_TRACE_OUTPUT_EDGES);
  return {
    ...graph,
    nodes: orderedNodes,
    edges: orderedEdges,
    omittedNodes: Math.max(0, graph.nodes.length - orderedNodes.length),
    omittedEdges: Math.max(0, graph.edges.length - orderedEdges.length)
  };
}

function tokenBudgetForTrace(graph: CappedTraceGraph) {
  const estimated = Math.ceil(JSON.stringify(graph).length / 4);
  return {
    requested: TRACE_TOKEN_BUDGET,
    used: Math.min(estimated, TRACE_TOKEN_BUDGET),
    truncated: graph.omittedNodes > 0 || graph.omittedEdges > 0 || estimated > TRACE_TOKEN_BUDGET
  };
}

export const nlTraceInputSchema = z
  .object({
    projectPath: z.string().optional(),
    target: z.string().min(1),
    targetType: z.enum(['auto', 'span', 'symbol', 'file', 'feature', 'config', 'doc']).default('auto'),
    direction: z.enum(['upstream', 'downstream', 'both']).default('both'),
    depth: z.number().int().min(0).max(5).default(2),
    relationTypes: z.array(z.string()).default(['all'])
  })
  .passthrough();

export async function handleNlTrace(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlTraceInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const graph = capTraceGraph(traceGraph({
    projectRoot,
    target: parsed.target,
    targetType: parsed.targetType,
    direction: parsed.direction,
    depth: parsed.depth,
    relationTypes: parsed.relationTypes
  }));

  return createEnvelope({
    ok: true,
    tool: 'nl_trace',
    projectRoot,
    graphRevision,
    graphState: graph.nodes.length > 0 ? 'ready' : 'partial',
    tokenBudget: tokenBudgetForTrace(graph),
    data: graph,
    evidence: graph.edges.map(edge => edge.evidence),
    nextActions: ['use nl_impact for grouped verification planning']
  });
}
