import { z } from 'zod';

import { generateCandidates } from '../../locator/candidate-generation.js';
import { rankCandidates } from '../../locator/ranking.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import { applyLocatorTokenBudget } from '../token-budget.js';

export const nlQueryInputSchema = z
  .object({
    projectPath: z.string().optional(),
    query: z.string().min(1),
    scope: z.string().optional(),
    limit: z.number().int().positive().max(100).default(10)
  })
  .passthrough();

type QueryResult = {
  spanId: string;
  path: string;
  kind: string;
  role: string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  score: number;
  scoreBreakdown: unknown;
  evidence: Array<Record<string, unknown>>;
  linkedSpans: Array<Record<string, unknown>>;
  estimatedTokens: number;
};

export async function handleNlQuery(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlQueryInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const generated = await generateCandidates({
    projectRoot,
    query: parsed.scope ? `${parsed.scope} ${parsed.query}` : parsed.query,
    limit: Math.max(parsed.limit, 50)
  });
  const ranked = rankCandidates(generated.candidates, generated.normalizedQuery);
  const results: QueryResult[] = ranked.slice(0, parsed.limit).map(candidate => ({
    spanId: candidate.spanId,
    path: candidate.path,
    kind: String(candidate.kind),
    role: String(candidate.role),
    label: candidate.label,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    headingPath: candidate.headingPath,
    score: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    evidence: candidate.evidence,
    linkedSpans: candidate.linkedSpans,
    estimatedTokens: 26 + candidate.evidence.length * 8 + candidate.linkedSpans.length * 4
  }));
  const budgeted = applyLocatorTokenBudget({
    requested: 1200,
    targets: results,
    warnings: generated.warnings
  });
  const budgetedResults = budgeted.targets.map(({ estimatedTokens, ...result }) => result);

  return createEnvelope({
    ok: true,
    tool: 'nl_query',
    projectRoot,
    graphRevision: generated.graphRevision,
    graphState: generated.graphState,
    tokenBudget: budgeted.tokenBudget,
    warnings: budgeted.warnings,
    data: {
      results: budgetedResults,
      normalizedQuery: generated.normalizedQuery
    },
    evidence: budgetedResults.flatMap(result => result.evidence),
    nextActions: ['use nl_locate for edit decisions']
  });
}
