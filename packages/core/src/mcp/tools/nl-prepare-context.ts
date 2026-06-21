import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type NoemaLoomEnvelope } from '../envelope.js';
import { planExactRoute, applyExactRoute } from '../exact-route.js';
import { RESPONSE_PROFILES, shapeEvidence, shapePrepareContextData, type ResponseProfile } from '../output-profile.js';
import {
  combineEvidence,
  combineWarnings
} from './aggregate-utils.js';
import { buildContextDataFromLocated } from './nl-context.js';
import { runLocator } from './nl-locate.js';
import { handleNlReadSpan } from './nl-read-span.js';
import { readWorksetManifest, recordNavigationTargets, renderNavigationCards, worksetRevision } from '../../state/workset.js';

type LocateData = {
  targets: Array<{
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
    decision: string;
    indexed?: boolean;
    promotionAction?: { target: 'paths'; paths: string[]; reason: string };
  }>;
  unindexedCandidates?: Array<{ path: string; promotionAction?: { target: 'paths'; paths: string[]; reason: string } }>;
  coverage?: unknown;
  coveragePlan: unknown;
  normalizedQuery: unknown;
};

export const nlPrepareContextInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    scope: z.string().optional(),
    targetRoles: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(20),
    budget: z.number().int().positive().max(10000).default(2400),
    includeSnippets: z.boolean().default(false),
    includeQueryPreview: z.boolean().default(true),
    readTopSpans: z.boolean().default(false),
    maxReadSpans: z.number().int().min(0).max(10).default(3),
    contextLines: z.number().int().min(0).max(80).default(10),
    recordNavigation: z.boolean().default(true),
    responseProfile: z.enum(RESPONSE_PROFILES).default('compact')
  })
  .passthrough();

function queryTargetCard(target: LocateData['targets'][number]): Record<string, unknown> {
  const hasLines = typeof target.startLine === 'number' && typeof target.endLine === 'number';
  return {
    spanId: target.spanId,
    path: target.path,
    label: target.label,
    kind: target.kind,
    role: target.role,
    lines: hasLines ? `${target.startLine}-${target.endLine}` : undefined,
    decision: target.decision,
    indexed: target.indexed ?? true
  };
}

function estimateOutputTokenBudget(input: {
  requested: number;
  data: Record<string, unknown>;
  evidence: unknown[];
  warnings: EnvelopeWarning[];
  nextActions: string[];
  truncated: boolean;
}) {
  const used = Math.ceil(JSON.stringify({ data: input.data, evidence: input.evidence, warnings: input.warnings, nextActions: input.nextActions }).length / 4);
  return {
    requested: input.requested,
    used,
    truncated: input.truncated
  };
}

export async function handleNlPrepareContext(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlPrepareContextInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const goal = parsed.scope ? `${parsed.scope} ${parsed.goal}` : parsed.goal;

  const located = await runLocator({
    projectRoot,
    goal,
    targetRoles: parsed.targetRoles,
    limit: parsed.limit,
    budget: parsed.budget
  });
  const router = planExactRoute({ normalizedQuery: located.normalizedQuery, targets: located.targets });
  const routedLocated = router.route === 'noemaloom_rank'
    ? located
    : { ...located, targets: applyExactRoute(located.targets, router) };
  const locateData: LocateData = {
    targets: routedLocated.targets,
    unindexedCandidates: routedLocated.targets.filter(target => target.indexed === false),
    coverage: routedLocated.coverage,
    coveragePlan: routedLocated.coveragePlan,
    normalizedQuery: routedLocated.normalizedQuery
  };
  const contextData = await buildContextDataFromLocated({
    projectRoot,
    located: routedLocated,
    includeSnippets: parsed.includeSnippets
  });
  const readTargets = parsed.readTopSpans && locateData.unindexedCandidates?.length === 0
    ? locateData.targets
      .filter(target => target.indexed !== false && ['must_edit', 'maybe_edit'].includes(target.decision))
        .slice(0, parsed.maxReadSpans)
    : [];
  const readResults = await Promise.all(
    readTargets.map(target =>
      handleNlReadSpan({
        projectPath: parsed.projectPath,
        spanId: target.spanId,
        contextLines: parsed.contextLines
      })
    )
  );
  const readWarnings = combineWarnings(readResults);
  const unindexedCandidates = locateData.unindexedCandidates ?? locateData.targets.filter(target => target.indexed === false);
  const ok = readResults.every(result => result.ok !== false);
  const graphState = readResults.some(result => result.graphState === 'stale') ? 'stale' : located.graphState;
  const nextActions = unindexedCandidates.length > 0
    ? ['call nl_refresh with target="paths" for unindexedCandidates', 'rerun nl_prepare_context after promotion']
    : ok && graphState === 'ready' && locateData.targets.length > 0
      ? ['edit with native agent tools', 'call nl_verify_task after edits']
      : ['call nl_refresh before editing', 'inspect nl_status warnings'];
  const queryPreview = parsed.includeQueryPreview
    ? locateData.targets.slice(0, Math.min(parsed.limit, 5)).map(target => ({
        spanId: target.spanId,
        path: target.path,
        kind: target.kind,
        role: target.role,
        label: target.label,
        startLine: target.startLine,
        endLine: target.endLine,
        headingPath: target.headingPath,
        score: target.score,
        scoreBreakdown: target.scoreBreakdown,
        evidence: target.evidence,
        linkedSpans: target.linkedSpans,
        indexed: target.indexed ?? true,
        promotionAction: target.promotionAction
      }))
    : [];
  const responseProfile = parsed.responseProfile as ResponseProfile;
  const worksetWarnings: EnvelopeWarning[] = [];
  const stateEffects: string[] = [];
  let navigation: Record<string, unknown> = {
    revision: null,
    cards: [],
    queryTargetCards: locateData.targets.slice(0, Math.min(parsed.limit, 10)).map(queryTargetCard),
    worksetCards: [],
    text: '',
    worksetText: '',
    enabled: false,
    charBudget: 0,
    truncated: false
  };
  try {
    const currentWorkset = await readWorksetManifest(projectRoot);
    const navigationEnabled = currentWorkset.options.navigation.enabled;
    const activateObservedTargets = navigationEnabled && currentWorkset.options.navigation.mode === 'inject';
    const shouldRecordNavigation = parsed.recordNavigation && navigationEnabled;
    const workset = shouldRecordNavigation
      ? await recordNavigationTargets({
          projectRoot,
          targets: locateData.targets,
          reason: 'nl_prepare_context target',
          maxTargets: Math.min(parsed.limit, 10),
          defaultState: activateObservedTargets ? 'active' : 'dormant',
          reviveDormant: activateObservedTargets,
          preserveCurated: true
        })
      : currentWorkset;
    if (shouldRecordNavigation) {
      stateEffects.push('workset.navigation_query_recorded');
    }
    const rendered = renderNavigationCards(workset, { includeDisabled: responseProfile === 'navigation' });
    const queryTargetCards = locateData.targets.slice(0, Math.min(parsed.limit, 10)).map(queryTargetCard);
    navigation = {
      revision: worksetRevision(workset),
      enabled: workset.options.navigation.enabled,
      counters: workset.counters,
      cards: queryTargetCards,
      queryTargetCards,
      worksetCards: rendered.cards,
      text: queryTargetCards.map(card => `- ${card.path}${card.lines ? `:${card.lines}` : ''} [${card.kind}/${card.role}] ${card.label} — ${card.decision}`).join('\n'),
      worksetText: rendered.text,
      charBudget: rendered.charBudget,
      truncated: rendered.truncated
    };
  } catch (error) {
    worksetWarnings.push({
      code: 'navigation_workset_record_failed',
      severity: 'warning',
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const data = {
    router,
    queryPreview,
    targets: locateData.targets,
    unindexedCandidates,
    coverage: locateData.coverage,
    coveragePlan: locateData.coveragePlan,
    normalizedQuery: locateData.normalizedQuery,
    navigation,
    context: contextData,
    readSpans: readResults.map(result => result.data),
    requiredActions: nextActions,
    stateEffects,
    steps: ['nl_locate', 'nl_context_from_located', ...readResults.map(result => result.tool)]
  };
  const evidence = [...routedLocated.targets.flatMap(target => target.evidence), ...combineEvidence(readResults)];
  const shapedData = shapePrepareContextData(data, responseProfile) as Record<string, unknown>;
  const shapedEvidence = shapeEvidence(evidence, responseProfile);
  const warnings = [...located.warnings, ...readWarnings, ...worksetWarnings];
  const tokenBudget = estimateOutputTokenBudget({
    requested: located.tokenBudget.requested,
    data: shapedData,
    evidence: shapedEvidence,
    warnings,
    nextActions,
    truncated: located.tokenBudget.truncated
  });

  return createEnvelope({
    ok,
    tool: 'nl_prepare_context',
    projectRoot,
    graphRevision: located.graphRevision,
    graphState,
    tokenBudget,
    warnings,
    data: shapedData,
    evidence: shapedEvidence,
    nextActions
  });
}
