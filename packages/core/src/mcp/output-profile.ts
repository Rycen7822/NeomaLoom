import { buildEvidenceBundle, type EvidenceBundleInput } from '../locator/evidence-bundle.js';

export type ResponseProfile = 'agent' | 'compact' | 'standard' | 'debug' | 'navigation';

export const RESPONSE_PROFILES = ['agent', 'compact', 'standard', 'debug', 'navigation'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function firstItems(value: unknown, limit: number): unknown[] {
  return asArray(value).slice(0, limit);
}

function slimTarget(target: unknown, profile: Exclude<ResponseProfile, 'debug'>): Record<string, unknown> {
  if (!isRecord(target)) {
    return { value: target };
  }
  const shaped: Record<string, unknown> = {
    spanId: target.spanId,
    decision: target.decision,
    path: target.path,
    kind: target.kind,
    role: target.role,
    label: target.label,
    startLine: target.startLine,
    endLine: target.endLine,
    recommendedReadRange: target.recommendedReadRange,
    headingPath: target.headingPath,
    confidence: target.confidence,
    reason: target.reason,
    editRisk: target.editRisk,
    indexed: target.indexed ?? true,
    promotionAction: target.promotionAction,
    editBoundary: target.editBoundary
  };
  const evidenceCount = countArray(target.evidence);
  const linkedSpanCount = countArray(target.linkedSpans);
  if (evidenceCount > 0) shaped.evidenceCount = evidenceCount;
  if (linkedSpanCount > 0) shaped.linkedSpanCount = linkedSpanCount;
  if (profile === 'standard') {
    shaped.score = target.score;
    shaped.scoreReasons = compactScoreBreakdown(target.scoreBreakdown, 5);
    shaped.evidenceBundle = buildEvidenceBundle(target as EvidenceBundleInput, { maxEvidence: 3, maxLinkedSpans: 3 });
  }
  return Object.fromEntries(Object.entries(shaped).filter(([, value]) => value !== undefined));
}

function compactScoreBreakdown(value: unknown, limit: number): Array<{ name: string; value: unknown }> {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => typeof entry === 'number' ? entry !== 0 : entry !== undefined && entry !== null)
    .sort((left, right) => Number(right[1] ?? 0) - Number(left[1] ?? 0))
    .slice(0, limit)
    .map(([name, entry]) => ({ name, value: entry }));
}

function summarizeRepositoryMap(value: unknown, profile: Exclude<ResponseProfile, 'debug'>): unknown {
  if (!isRecord(value)) return value ?? null;
  const summary: Record<string, unknown> = {
    graphRevision: value.graphRevision ?? null,
    directoryRoleCount: countArray(value.directoryRoles),
    canonicalDocCount: countArray(value.canonicalDocs),
    coreSourceModuleCount: countArray(value.coreSourceModules),
    docSurfaceCount: countArray(value.docSurfaces),
    highConfidenceLinkCount: countArray(value.highConfidenceLinks),
    warningCount: countArray(value.warnings)
  };
  if (profile === 'standard') {
    summary.canonicalDocsPreview = firstItems(value.canonicalDocs, 5);
    summary.coreSourceModulesPreview = firstItems(value.coreSourceModules, 5);
    summary.warningsPreview = firstItems(value.warnings, 5);
  }
  return summary;
}

function summarizeTargetGroup(value: unknown): Record<string, unknown> {
  const items = asArray(value);
  return {
    count: items.length,
    paths: [...new Set(items.map(item => isRecord(item) ? item.path : undefined).filter(Boolean))].slice(0, 20)
  };
}

function shapeContextData(value: unknown, profile: Exclude<ResponseProfile, 'debug'>): unknown {
  if (!isRecord(value)) return value;
  const suggestedReadOrder = asArray(value.suggestedReadOrder).map(item => {
    if (!isRecord(item)) return item;
    return {
      spanId: item.spanId,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine
    };
  });
  const shaped: Record<string, unknown> = {
    repositoryMapSummary: summarizeRepositoryMap(value.repositoryMap, profile),
    targetGroupSummary: {
      primaryTargets: summarizeTargetGroup(value.primaryTargets),
      secondaryTargets: summarizeTargetGroup(value.secondaryTargets),
      supportingCode: summarizeTargetGroup(value.supportingCode),
      supportingDocs: summarizeTargetGroup(value.supportingDocs),
      supportingConfig: summarizeTargetGroup(value.supportingConfig),
      supportingTests: summarizeTargetGroup(value.supportingTests),
      featureContext: summarizeTargetGroup(value.featureContext)
    },
    riskNotes: value.riskNotes,
    suggestedReadOrder,
    includeSnippets: value.includeSnippets ?? false
  };
  if (profile === 'standard') {
    shaped.primaryTargets = asArray(value.primaryTargets).slice(0, 5);
    shaped.supportingDocs = asArray(value.supportingDocs).slice(0, 5);
    shaped.supportingCode = asArray(value.supportingCode).slice(0, 5);
    shaped.supportingTests = asArray(value.supportingTests).slice(0, 5);
  }
  return shaped;
}

function summarizeTrace(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nodes = asArray(value.nodes);
  const edges = asArray(value.edges);
  const edgeCounts: Record<string, number> = {};
  for (const edge of edges) {
    const relation = isRecord(edge) && typeof edge.relation === 'string' ? edge.relation : 'unknown';
    edgeCounts[relation] = (edgeCounts[relation] ?? 0) + 1;
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    seedSpanIds: value.seedSpanIds,
    impactCoverage: value.impactCoverage,
    missingUnindexedPaths: value.missingUnindexedPaths,
    omittedNodes: value.omittedNodes,
    omittedEdges: value.omittedEdges,
    edgeCounts
  };
}

function slimImpactNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  return {
    spanId: node.spanId,
    path: node.path,
    kind: node.kind,
    role: node.role,
    label: node.label,
    startLine: node.startLine,
    endLine: node.endLine
  };
}

export function shapeImpact(value: unknown, profile: Exclude<ResponseProfile, 'debug'>): unknown {
  if (!isRecord(value)) return value;
  const limit = profile === 'agent' ? 5 : profile === 'compact' ? 12 : 25;
  const shaped: Record<string, unknown> = {
    codeImpact: asArray(value.codeImpact).slice(0, limit).map(slimImpactNode),
    docImpact: asArray(value.docImpact).slice(0, limit).map(slimImpactNode),
    configImpact: asArray(value.configImpact).slice(0, limit).map(slimImpactNode),
    testImpact: asArray(value.testImpact).slice(0, limit).map(slimImpactNode),
    exampleImpact: asArray(value.exampleImpact).slice(0, limit).map(slimImpactNode),
    featureImpact: asArray(value.featureImpact).slice(0, limit).map(slimImpactNode),
    impactCoverage: value.impactCoverage,
    missingUnindexedPaths: value.missingUnindexedPaths,
    riskLevel: value.riskLevel,
    requiredVerification: value.requiredVerification,
    requiredVerificationDetails: value.requiredVerificationDetails,
    requiredActions: value.requiredActions,
    omitted: {
      codeImpact: Math.max(0, countArray(value.codeImpact) - limit),
      docImpact: Math.max(0, countArray(value.docImpact) - limit),
      configImpact: Math.max(0, countArray(value.configImpact) - limit),
      testImpact: Math.max(0, countArray(value.testImpact) - limit),
      exampleImpact: Math.max(0, countArray(value.exampleImpact) - limit),
      featureImpact: Math.max(0, countArray(value.featureImpact) - limit)
    }
  };
  return shaped;
}

function summarizeImpact(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    codeImpactCount: countArray(value.codeImpact),
    docImpactCount: countArray(value.docImpact),
    configImpactCount: countArray(value.configImpact),
    testImpactCount: countArray(value.testImpact),
    exampleImpactCount: countArray(value.exampleImpact),
    featureImpactCount: countArray(value.featureImpact),
    impactCoverage: value.impactCoverage,
    missingUnindexedPathCount: countArray(value.missingUnindexedPaths),
    riskLevel: value.riskLevel
  };
}

function previewText(value: unknown, maxChars: number): { preview: string; omittedChars: number } {
  if (typeof value !== 'string') return { preview: '', omittedChars: 0 };
  return {
    preview: value.slice(0, maxChars),
    omittedChars: Math.max(0, value.length - maxChars)
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function cappedArray(value: unknown, limit: number): { items: unknown[]; omitted: number } {
  const items = asArray(value);
  return {
    items: items.slice(0, limit),
    omitted: Math.max(0, items.length - limit)
  };
}

function shapeCoveragePlan(value: unknown, profile: ResponseProfile): unknown {
  if (profile === 'debug' || !isRecord(value)) return value;
  const limit = profile === 'standard' ? 25 : profile === 'compact' ? 12 : profile === 'navigation' ? 8 : 5;
  const exactSweeps = cappedArray(value.exactSweeps, limit);
  const pathRoles = cappedArray(value.pathRolesToVerify, limit);
  const linkedDocs = cappedArray(value.linkedDocsToVerify, limit);
  const linkedTests = cappedArray(value.linkedTestsToVerify, limit);
  return {
    exactSweeps: exactSweeps.items,
    exactSweepsOmitted: exactSweeps.omitted,
    pathRolesToVerify: pathRoles.items,
    pathRolesToVerifyOmitted: pathRoles.omitted,
    linkedDocsToVerify: linkedDocs.items,
    linkedDocsToVerifyOmitted: numberValue(value.linkedDocsToVerifyOmitted) + linkedDocs.omitted,
    linkedTestsToVerify: linkedTests.items,
    linkedTestsToVerifyOmitted: numberValue(value.linkedTestsToVerifyOmitted) + linkedTests.omitted,
    warnings: firstItems(value.warnings, profile === 'standard' ? 10 : 5)
  };
}

function shapeReadSpan(value: unknown, profile: ResponseProfile): unknown {
  if (!isRecord(value)) return value;
  const full = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  if (profile === 'debug' || profile === 'standard') return full;
  const content = previewText(value.content, profile === 'agent' ? 420 : profile === 'navigation' ? 360 : 800);
  const { content: _content, ...rest } = full;
  return Object.fromEntries(Object.entries({
    ...rest,
    contentPreview: content.preview,
    contentPreviewOmittedChars: content.omittedChars
  }).filter(([, entry]) => entry !== undefined));
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function lineRange(value: Record<string, unknown>, startKey = 'startLine', endKey = 'endLine'): string | undefined {
  const start = numberOrUndefined(value[startKey]);
  const end = numberOrUndefined(value[endKey]);
  return start !== undefined && end !== undefined ? `${start}-${end}` : undefined;
}

function countByField(items: unknown[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = isRecord(item) && typeof item[field] === 'string' ? item[field] : 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function compactPromotionAction(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries({
    target: value.target,
    paths: firstItems(value.paths, 5),
    reason: value.reason
  }).filter(([, entry]) => entry !== undefined));
}

function agentTarget(target: unknown): Record<string, unknown> {
  if (!isRecord(target)) {
    return { value: target };
  }
  const shaped: Record<string, unknown> = {
    spanId: target.spanId,
    decision: target.decision,
    path: target.path,
    kind: target.kind,
    role: target.role,
    label: target.label,
    startLine: target.startLine,
    endLine: target.endLine,
    lines: lineRange(target),
    confidence: target.confidence,
    indexed: target.indexed ?? true,
    promotionAction: compactPromotionAction(target.promotionAction)
  };
  const evidenceCount = countArray(target.evidence);
  const linkedSpanCount = countArray(target.linkedSpans);
  if (evidenceCount > 0) shaped.evidenceCount = evidenceCount;
  if (linkedSpanCount > 0) shaped.linkedSpanCount = linkedSpanCount;
  const why = compactScoreBreakdown(target.scoreBreakdown, 2).map(item => item.name);
  if (why.length > 0) shaped.why = why;
  return Object.fromEntries(Object.entries(shaped).filter(([, value]) => value !== undefined));
}

function summarizeUnindexedCandidates(value: unknown, limit: number): Record<string, unknown> {
  const items = asArray(value);
  return {
    count: items.length,
    paths: items.map(item => isRecord(item) ? stringOrUndefined(item.path) : undefined).filter(Boolean).slice(0, limit),
    omitted: Math.max(0, items.length - limit),
    promotionActions: items
      .map(item => isRecord(item) ? compactPromotionAction(item.promotionAction) : undefined)
      .filter(Boolean)
      .slice(0, limit)
  };
}

function agentReadHint(value: unknown, reason: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const range = reason === 'readTopSpans'
    ? lineRange(value, 'spanStartLine', 'spanEndLine') ?? lineRange(value)
    : lineRange(value) ?? lineRange(value, 'spanStartLine', 'spanEndLine');
  const pathValue = value.path;
  if (typeof pathValue !== 'string') return null;
  return Object.fromEntries(Object.entries({
    spanId: value.spanId,
    path: pathValue,
    range,
    reason
  }).filter(([, entry]) => entry !== undefined));
}

function buildReadHints(targets: unknown, readSpans: unknown): Record<string, unknown>[] {
  const fromReadSpans = asArray(readSpans)
    .map(span => agentReadHint(span, 'readTopSpans'))
    .filter((item): item is Record<string, unknown> => item !== null);
  if (fromReadSpans.length > 0) return fromReadSpans.slice(0, 5);
  return asArray(targets)
    .filter(target => isRecord(target) && ['must_edit', 'maybe_edit', 'verify_only'].includes(String(target.decision)))
    .map(target => agentReadHint(target, String(isRecord(target) ? target.decision : 'target')))
    .filter((item): item is Record<string, unknown> => item !== null)
    .slice(0, 5);
}

function summarizeReadSkipReasons(value: unknown): Record<string, unknown> {
  const items = asArray(value);
  return {
    count: items.length,
    reasons: countByField(items, 'reason')
  };
}

function shapeAgentPrepareContextData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const allTargets = asArray(value.targets);
  const targetLimit = 5;
  const targets = allTargets.slice(0, targetLimit).map(agentTarget);
  const coveragePlan = shapeCoveragePlan(value.coveragePlan, 'agent');
  const unindexedCandidates = asArray(value.unindexedCandidates);
  const readSkipSummary = summarizeReadSkipReasons(value.readSkipReasons);
  return Object.fromEntries(Object.entries({
    router: value.router,
    summary: {
      targetCount: allTargets.length,
      returnedTargets: targets.length,
      omittedTargets: Math.max(0, allTargets.length - targets.length),
      decisions: countByField(allTargets, 'decision'),
      roles: countByField(allTargets, 'role')
    },
    targets,
    ...(unindexedCandidates.length > 0 ? {
      unindexedCandidates: unindexedCandidates.slice(0, 5).map(agentTarget),
      unindexedCandidateSummary: summarizeUnindexedCandidates(value.unindexedCandidates, 5)
    } : {}),
    coverage: value.coverage,
    coveragePlan,
    coverageDigest: coveragePlan,
    readHints: buildReadHints(value.targets, value.readSpans),
    readSpans: asArray(value.readSpans).slice(0, 3).map(span => shapeReadSpan(span, 'agent')),
    ...(Number(readSkipSummary.count) > 0 ? { readSkipSummary } : {}),
    requiredActions: value.requiredActions,
    ...(countArray(value.stateEffects) > 0 ? { stateEffects: value.stateEffects } : {})
  }).filter(([, entry]) => entry !== undefined));
}

function shapeNavigationPrepareContextData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    router: value.router,
    navigation: value.navigation,
    targets: asArray(value.targets).slice(0, 5).map(target => slimTarget(target, 'compact')),
    unindexedCandidates: value.unindexedCandidates,
    coverage: value.coverage,
    coveragePlan: shapeCoveragePlan(value.coveragePlan, 'navigation'),
    readSpans: asArray(value.readSpans).slice(0, 3).map(span => shapeReadSpan(span, 'navigation')),
    readSkipReasons: asArray(value.readSkipReasons).slice(0, 10),
    requiredActions: value.requiredActions,
    stateEffects: value.stateEffects,
    stateEffectsDetailed: value.stateEffectsDetailed,
    steps: value.steps
  };
}

export function shapePrepareContextData(value: unknown, profile: ResponseProfile): unknown {
  if (profile === 'debug' || !isRecord(value)) return value;
  if (profile === 'agent') return shapeAgentPrepareContextData(value);
  if (profile === 'navigation') return shapeNavigationPrepareContextData(value);
  return {
    router: value.router,
    ...(profile === 'standard' ? { queryPreview: asArray(value.queryPreview).slice(0, 5).map(item => slimTarget(item, 'standard')) } : { queryPreview: [] }),
    targets: asArray(value.targets).map(target => slimTarget(target, profile)),
    unindexedCandidates: value.unindexedCandidates,
    coverage: value.coverage,
    coveragePlan: shapeCoveragePlan(value.coveragePlan, profile),
    ...(profile === 'standard' ? { normalizedQuery: value.normalizedQuery } : {}),
    context: shapeContextData(value.context, profile),
    readSpans: asArray(value.readSpans).map(span => shapeReadSpan(span, profile)),
    readSkipReasons: asArray(value.readSkipReasons).slice(0, 20),
    stateEffects: value.stateEffects,
    stateEffectsDetailed: value.stateEffectsDetailed,
    steps: value.steps
  };
}

export function shapePlanChangeData(value: unknown, profile: ResponseProfile): unknown {
  if (profile === 'debug' || !isRecord(value)) return value;
  const traceSummary = summarizeTrace(value.trace);
  const impactSummary = summarizeImpact(value.impact);
  if (profile === 'agent') {
    const allTargets = asArray(value.targets);
    const targets = allTargets.slice(0, 8).map(agentTarget);
    return {
      summary: {
        targetCount: allTargets.length,
        returnedTargets: targets.length,
        omittedTargets: Math.max(0, allTargets.length - targets.length),
        decisions: countByField(allTargets, 'decision'),
        roles: countByField(allTargets, 'role')
      },
      targets,
      coveragePlan: shapeCoveragePlan(value.coveragePlan, 'agent'),
      traceSummary,
      impactSummary,
      requiredVerification: value.requiredVerification,
      requiredActions: value.requiredActions
    };
  }
  return {
    targets: asArray(value.targets).map(target => slimTarget(target, profile)),
    coveragePlan: shapeCoveragePlan(value.coveragePlan, profile),
    ...(profile === 'standard' ? { normalizedQuery: value.normalizedQuery } : {}),
    trace: null,
    traceSummary,
    impact: shapeImpact(value.impact, profile),
    impactSummary,
    requiredVerification: value.requiredVerification,
    requiredVerificationDetails: value.requiredVerificationDetails,
    requiredActions: value.requiredActions,
    steps: value.steps
  };
}

function shapeVerificationCoverage(value: unknown, limit: number): unknown {
  if (!isRecord(value)) return value;
  const shaped: Record<string, unknown> = {};
  const omitted: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      shaped[key] = entry.slice(0, limit);
      omitted[key] = Math.max(0, entry.length - limit);
      continue;
    }
    if (
      entry === null ||
      ['string', 'number', 'boolean'].includes(typeof entry) ||
      (isRecord(entry) && ['summary', 'counts'].includes(key))
    ) {
      shaped[key] = entry;
    }
  }
  shaped.omitted = omitted;
  return shaped;
}

export function shapeVerifyTaskData(value: unknown, profile: ResponseProfile): unknown {
  if (profile === 'debug' || !isRecord(value)) return value;
  if (profile === 'agent') {
    return Object.fromEntries(Object.entries({
      status: value.status,
      coverage: shapeVerificationCoverage(value.coverage, 5),
      impactSummary: summarizeImpact(value.impact),
      traceSummary: summarizeTrace(value.trace),
      requiredVerification: value.requiredVerification,
      requiredActions: value.requiredActions
    }).filter(([, entry]) => entry !== undefined));
  }
  return {
    ...value,
    impact: value.impact ? shapeImpact(value.impact, profile === 'standard' ? 'standard' : 'compact') : null,
    trace: profile === 'standard' ? value.trace : null,
    traceSummary: summarizeTrace(value.trace),
    impactSummary: summarizeImpact(value.impact)
  };
}

function trimPreviewFields(value: unknown, maxChars: number): unknown {
  if (!isRecord(value)) return value;
  const contentPreview = typeof value.contentPreview === 'string'
    ? value.contentPreview.slice(0, maxChars)
    : value.contentPreview;
  return Object.fromEntries(Object.entries({
    ...value,
    contentPreview,
    contentPreviewOmittedChars: typeof value.contentPreview === 'string'
      ? numberValue(value.contentPreviewOmittedChars) + Math.max(0, value.contentPreview.length - maxChars)
      : value.contentPreviewOmittedChars
  }).filter(([, entry]) => entry !== undefined));
}

function capRecordArrays(value: unknown, limit: number): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (Array.isArray(entry)) return [key, entry.slice(0, limit)];
    return [key, entry];
  }));
}

function trimAgentTargetForBudget(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries({
    spanId: value.spanId,
    decision: value.decision,
    path: value.path,
    kind: value.kind,
    role: value.role,
    label: value.label,
    startLine: value.startLine,
    endLine: value.endLine,
    lines: value.lines,
    confidence: value.confidence,
    indexed: value.indexed,
    promotionAction: value.promotionAction
  }).filter(([, entry]) => entry !== undefined));
}

export function trimAgentDataForBudget(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries({
    summary: isRecord(value.summary)
      ? {
          targetCount: value.summary.targetCount,
          returnedTargets: value.summary.returnedTargets,
          omittedTargets: value.summary.omittedTargets,
          decisions: value.summary.decisions
        }
      : value.summary,
    targets: asArray(value.targets).slice(0, 3).map(trimAgentTargetForBudget),
    unindexedCandidates: asArray(value.unindexedCandidates).slice(0, 3).map(trimAgentTargetForBudget),
    unindexedCandidateSummary: value.unindexedCandidateSummary,
    coverage: value.coverage,
    coveragePlan: capRecordArrays(value.coveragePlan, 3),
    readHints: asArray(value.readHints).slice(0, 3),
    readSpans: asArray(value.readSpans).slice(0, 2).map(span => trimPreviewFields(span, 180)),
    requiredActions: asArray(value.requiredActions).slice(0, 4),
    stateEffects: value.stateEffects,
    debugArtifact: value.debugArtifact,
    budgetTrimmed: true
  }).filter(([, entry]) => {
    if (Array.isArray(entry) && entry.length === 0) return false;
    return entry !== undefined;
  }));
}

export function shapeEvidence(evidence: unknown[] | undefined, profile: ResponseProfile): unknown[] {
  if (profile === 'debug') return evidence ?? [];
  if (profile === 'standard') return (evidence ?? []).slice(0, 12);
  return [];
}
