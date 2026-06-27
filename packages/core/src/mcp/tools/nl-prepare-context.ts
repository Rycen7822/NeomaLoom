import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type GraphState, type NoemaLoomEnvelope } from '../envelope.js';
import { writeMcpDebugArtifact } from '../debug-artifact.js';
import { planExactRoute, applyExactRoute } from '../exact-route.js';
import { RESPONSE_PROFILES, shapeEvidence, shapePrepareContextData, trimAgentDataForBudget, type ResponseProfile } from '../output-profile.js';
import { estimateEnvelopeTokenBudget } from '../token-budget.js';
import { buildCoveragePlan } from '../../locator/coverage-plan.js';
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
    confidence: number;
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
    responseProfile: z.enum(RESPONSE_PROFILES).default('agent')
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

function readPriority(decision: string): number {
  if (decision === 'must_edit') return 0;
  if (decision === 'maybe_edit') return 1;
  if (decision === 'verify_only') return 2;
  if (decision === 'inspect_only') return 3;
  return 4;
}

function shouldReadTarget(target: LocateData['targets'][number]): boolean {
  if (target.indexed === false) return false;
  if (['must_edit', 'maybe_edit'].includes(target.decision)) return true;
  if (['inspect_only', 'verify_only'].includes(target.decision)) return Number(target.confidence ?? 0) >= 0.45;
  return false;
}

function selectReadTargets(input: {
  targets: LocateData['targets'];
  enabled: boolean;
  hasUnindexedCandidates: boolean;
  maxReadSpans: number;
}): { readTargets: LocateData['targets']; readSkipReasons: Array<Record<string, unknown>> } {
  if (!input.enabled) return { readTargets: [], readSkipReasons: [] };
  if (input.hasUnindexedCandidates) {
    return {
      readTargets: [],
      readSkipReasons: input.targets
        .filter(target => target.indexed === false)
        .map(target => ({ spanId: target.spanId, path: target.path, reason: 'unindexed_candidate_requires_promotion' }))
    };
  }
  const ordered = input.targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => readPriority(left.target.decision) - readPriority(right.target.decision) || left.index - right.index);
  const readTargets = ordered.filter(item => shouldReadTarget(item.target)).slice(0, input.maxReadSpans).map(item => item.target);
  const selected = new Set(readTargets.map(target => target.spanId));
  const readSkipReasons = ordered
    .filter(item => !selected.has(item.target.spanId))
    .map(item => ({
      spanId: item.target.spanId,
      path: item.target.path,
      decision: item.target.decision,
      confidence: item.target.confidence,
      reason: item.target.indexed === false
        ? 'unindexed_candidate_requires_promotion'
        : shouldReadTarget(item.target)
          ? 'maxReadSpans_exceeded'
          : 'decision_or_confidence_below_read_threshold'
    }))
    .slice(0, 20);
  return { readTargets, readSkipReasons };
}

function navigationStateEffectDetail(input: {
  beforeCounters: Record<string, number>;
  afterCounters: Record<string, number>;
  mode: string;
  enabled: boolean;
  targetCount: number;
}): Record<string, unknown> {
  const changedCounters = Object.entries(input.afterCounters)
    .filter(([key, value]) => value !== input.beforeCounters[key])
    .reduce<Record<string, { before: number; after: number }>>((acc, [key, after]) => {
      acc[key] = { before: input.beforeCounters[key] ?? 0, after };
      return acc;
    }, {});
  return {
    effect: 'workset.navigation_query_recorded',
    sourceWrites: false,
    derivedIndexWrites: false,
    worksetWrites: true,
    counterWrites: Object.keys(changedCounters),
    counterDelta: changedCounters,
    navigationMode: input.mode,
    navigationEnabled: input.enabled,
    targetCount: input.targetCount
  };
}

function navigationCapWarnings(input: {
  targets: LocateData['targets'];
  maxTargets: number;
  perPathMax: number;
  renderedTruncated: boolean;
}): EnvelopeWarning[] {
  const warnings: EnvelopeWarning[] = [];
  if (input.targets.length > input.maxTargets) {
    warnings.push({
      code: 'navigation_targets_capped',
      severity: 'info',
      message: `Navigation workset records at most ${input.maxTargets} targets for this call; ${input.targets.length - input.maxTargets} query targets were not recorded.`
    });
  }
  const perPath = new Map<string, number>();
  for (const target of input.targets.slice(0, input.maxTargets)) {
    perPath.set(target.path, (perPath.get(target.path) ?? 0) + 1);
  }
  const cappedPaths = [...perPath.entries()].filter(([, count]) => count > input.perPathMax).map(([repoPath]) => repoPath);
  if (cappedPaths.length > 0) {
    warnings.push({
      code: 'navigation_per_path_cap_applied',
      severity: 'info',
      message: `Navigation workset per-path cap may demote duplicate anchors for: ${cappedPaths.slice(0, 5).join(', ')}${cappedPaths.length > 5 ? '…' : ''}.`
    });
  }
  if (input.renderedTruncated) {
    warnings.push({
      code: 'navigation_workset_text_truncated',
      severity: 'info',
      message: 'Navigation workset text exceeded its injection character budget; use responseProfile="debug" or nl_status(includeAnchors=true) for the full workset.'
    });
  }
  return warnings;
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
  const coveragePlan = buildCoveragePlan({
    query: located.normalizedQuery as Parameters<typeof buildCoveragePlan>[0]['query'],
    targets: routedLocated.targets,
    requestedRoles: parsed.targetRoles
  });
  const locateData: LocateData = {
    targets: routedLocated.targets,
    unindexedCandidates: routedLocated.targets.filter(target => target.indexed === false),
    coverage: routedLocated.coverage,
    coveragePlan,
    normalizedQuery: routedLocated.normalizedQuery
  };
  const contextData = await buildContextDataFromLocated({
    projectRoot,
    located: routedLocated,
    includeSnippets: parsed.includeSnippets
  });
  const readSelection = selectReadTargets({
    targets: locateData.targets,
    enabled: parsed.readTopSpans,
    hasUnindexedCandidates: (locateData.unindexedCandidates?.length ?? 0) > 0,
    maxReadSpans: parsed.maxReadSpans
  });
  const readTargets = readSelection.readTargets;
  const readResults = await Promise.all(
    readTargets.map(target =>
      handleNlReadSpan({
        projectPath: parsed.projectPath,
        spanId: target.spanId,
        contextLines: parsed.contextLines,
        focusStartLine: target.startLine,
        focusEndLine: target.endLine
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
  const stateEffectsDetailed: Array<Record<string, unknown>> = [];
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
    const maxNavigationTargets = Math.min(parsed.limit, 10);
    const workset = shouldRecordNavigation
      ? await recordNavigationTargets({
          projectRoot,
          targets: locateData.targets,
          reason: 'nl_prepare_context target',
          maxTargets: maxNavigationTargets,
          defaultState: activateObservedTargets ? 'active' : 'dormant',
          reviveDormant: activateObservedTargets,
          preserveCurated: true
        })
      : currentWorkset;
    if (shouldRecordNavigation) {
      stateEffects.push('workset.navigation_query_recorded');
      stateEffectsDetailed.push(navigationStateEffectDetail({
        beforeCounters: currentWorkset.counters as unknown as Record<string, number>,
        afterCounters: workset.counters as unknown as Record<string, number>,
        mode: currentWorkset.options.navigation.mode,
        enabled: navigationEnabled,
        targetCount: Math.min(locateData.targets.length, maxNavigationTargets)
      }));
      if (currentWorkset.options.navigation.mode === 'silent') {
        worksetWarnings.push({
          code: 'navigation_silent_state_effect',
          severity: 'info',
          message: 'recordNavigation=true with navigation mode=silent records dormant workset/query counters but performs no source writes or injection.'
        });
      }
    }
    const rendered = renderNavigationCards(workset, { includeDisabled: responseProfile === 'navigation' });
    worksetWarnings.push(...navigationCapWarnings({
      targets: locateData.targets,
      maxTargets: maxNavigationTargets,
      perPathMax: workset.budgets.perPathMax,
      renderedTruncated: rendered.truncated
    }));
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
    readSkipReasons: readSelection.readSkipReasons,
    requiredActions: nextActions,
    stateEffects,
    stateEffectsDetailed,
    steps: ['nl_locate', 'nl_context_from_located', ...readResults.map(result => result.tool)]
  };
  const evidence = [...routedLocated.targets.flatMap(target => target.evidence), ...combineEvidence(readResults)];
  let shapedData = shapePrepareContextData(data, responseProfile) as Record<string, unknown>;
  const shapedEvidence = shapeEvidence(evidence, responseProfile);
  const warnings = [...located.warnings, ...readWarnings, ...worksetWarnings];
  const artifactWarnings: EnvelopeWarning[] = [];
  if (responseProfile !== 'debug') {
    try {
      shapedData = {
        ...shapedData,
        debugArtifact: await writeMcpDebugArtifact({
          projectRoot,
          tool: 'nl_prepare_context',
          responseProfile,
          data,
          evidence,
          warnings,
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
  let budgetWarnings: EnvelopeWarning[] = [...warnings, ...artifactWarnings];
  let finalizedBudget = estimateEnvelopeTokenBudget({
    requested: located.tokenBudget.requested,
    data: shapedData,
    evidence: shapedEvidence,
    warnings: budgetWarnings,
    nextActions,
    truncated: located.tokenBudget.truncated
  });
  if (responseProfile === 'agent' && finalizedBudget.tokenBudget.used > finalizedBudget.tokenBudget.requested) {
    shapedData = trimAgentDataForBudget(shapedData) as Record<string, unknown>;
    budgetWarnings = [
      ...budgetWarnings,
      {
        code: 'output_trimmed_to_budget',
        severity: 'info',
        message: 'Agent output exceeded the requested budget after first-pass shaping; non-critical arrays/previews were trimmed while preserving targets, warnings, actions, and debugArtifact.'
      }
    ];
    finalizedBudget = estimateEnvelopeTokenBudget({
      requested: located.tokenBudget.requested,
      data: shapedData,
      evidence: shapedEvidence,
      warnings: budgetWarnings,
      nextActions,
      truncated: true
    });
  }

  return createEnvelope({
    ok,
    tool: 'nl_prepare_context',
    projectRoot,
    graphRevision: located.graphRevision,
    graphState,
    tokenBudget: finalizedBudget.tokenBudget,
    warnings: finalizedBudget.warnings,
    data: shapedData,
    evidence: shapedEvidence,
    nextActions
  });
}
