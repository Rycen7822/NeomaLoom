import { buildEvidenceBundle, type EvidenceBundleInput } from '../locator/evidence-bundle.js';

export type ResponseProfile = 'compact' | 'standard' | 'debug' | 'navigation';

export const RESPONSE_PROFILES = ['compact', 'standard', 'debug', 'navigation'] as const;

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

function shapeImpact(value: unknown, profile: Exclude<ResponseProfile, 'debug'>): unknown {
  if (!isRecord(value)) return value;
  const limit = profile === 'compact' ? 12 : 25;
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

function shapeReadSpan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function shapeNavigationPrepareContextData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    router: value.router,
    navigation: value.navigation,
    targets: asArray(value.targets).slice(0, 5).map(target => slimTarget(target, 'compact')),
    unindexedCandidates: value.unindexedCandidates,
    coverage: value.coverage,
    coveragePlan: value.coveragePlan,
    readSpans: asArray(value.readSpans).slice(0, 3).map(shapeReadSpan),
    readSkipReasons: asArray(value.readSkipReasons).slice(0, 10),
    requiredActions: value.requiredActions,
    stateEffects: value.stateEffects,
    stateEffectsDetailed: value.stateEffectsDetailed,
    steps: value.steps
  };
}

export function shapePrepareContextData(value: unknown, profile: ResponseProfile): unknown {
  if (profile === 'debug' || !isRecord(value)) return value;
  if (profile === 'navigation') return shapeNavigationPrepareContextData(value);
  return {
    router: value.router,
    ...(profile === 'standard' ? { queryPreview: asArray(value.queryPreview).slice(0, 5).map(item => slimTarget(item, 'standard')) } : { queryPreview: [] }),
    targets: asArray(value.targets).map(target => slimTarget(target, profile)),
    unindexedCandidates: value.unindexedCandidates,
    coverage: value.coverage,
    coveragePlan: value.coveragePlan,
    ...(profile === 'standard' ? { normalizedQuery: value.normalizedQuery } : {}),
    context: shapeContextData(value.context, profile),
    readSpans: asArray(value.readSpans).map(shapeReadSpan),
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
  return {
    targets: asArray(value.targets).map(target => slimTarget(target, profile)),
    coveragePlan: value.coveragePlan,
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

export function shapeEvidence(evidence: unknown[] | undefined, profile: ResponseProfile): unknown[] {
  if (profile === 'debug') return evidence ?? [];
  if (profile === 'standard') return (evidence ?? []).slice(0, 12);
  return [];
}
