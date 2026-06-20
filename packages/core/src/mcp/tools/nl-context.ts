import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';
import { runLocator, type LocatorRunResult, type LocatorTarget } from './nl-locate.js';

const DEFAULT_CONTEXT_ROLES = [
  'source_file',
  'test_file',
  'config_file',
  'canonical_api_doc',
  'readme_doc',
  'quickstart_doc',
  'tutorial_doc',
  'example_doc',
  'design_doc',
  'changelog_doc'
] as const;

export const nlContextInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    budget: z.number().int().positive().max(10000).default(2048),
    includeSnippets: z.boolean().default(false)
  })
  .passthrough();

async function readRepositoryMap(projectRoot: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function summarizeRepositoryMap(map: unknown): unknown {
  if (!map || typeof map !== 'object') {
    return null;
  }
  const typed = map as Record<string, unknown>;
  return {
    graphRevision: typed.graphRevision ?? null,
    directoryRoles: Array.isArray(typed.directoryRoles) ? typed.directoryRoles.slice(0, 20) : [],
    canonicalDocs: Array.isArray(typed.canonicalDocs) ? typed.canonicalDocs.slice(0, 20) : [],
    coreSourceModules: Array.isArray(typed.coreSourceModules) ? typed.coreSourceModules.slice(0, 20) : [],
    docSurfaces: Array.isArray(typed.docSurfaces) ? typed.docSurfaces.slice(0, 20) : [],
    highConfidenceLinks: Array.isArray(typed.highConfidenceLinks) ? typed.highConfidenceLinks.slice(0, 20) : [],
    warnings: Array.isArray(typed.warnings) ? typed.warnings.slice(0, 20) : []
  };
}

function slimTarget(target: LocatorTarget): Record<string, unknown> {
  return {
    spanId: target.spanId,
    decision: target.decision,
    path: target.path,
    role: target.role,
    kind: target.kind,
    label: target.label,
    startLine: target.startLine,
    endLine: target.endLine,
    recommendedReadRange: target.recommendedReadRange,
    confidence: target.confidence,
    score: target.score,
    reason: target.reason,
    indexed: target.indexed ?? true,
    promotionAction: target.promotionAction,
    editBoundary: target.editBoundary
  };
}

function byRole(targets: LocatorTarget[], roles: string[]): LocatorTarget[] {
  return targets.filter(target => roles.includes(target.role));
}

export async function buildContextDataFromLocated(input: {
  projectRoot: string;
  located: LocatorRunResult;
  includeSnippets?: boolean;
}): Promise<Record<string, unknown>> {
  const targets = input.located.targets;
  const primaryTargets = targets.filter(target => ['must_edit', 'maybe_edit'].includes(target.decision));
  const secondaryTargets = targets.filter(target => target.decision === 'inspect_only');
  const supportingTests = byRole(targets, ['test_file']);
  const supportingDocs = targets.filter(target => target.role.endsWith('_doc'));
  const supportingCode = byRole(targets, ['source_file']);
  const supportingConfig = byRole(targets, ['config_file', 'schema_file', 'package_metadata']);

  return {
    repositoryMap: summarizeRepositoryMap(await readRepositoryMap(input.projectRoot)),
    primaryTargets: primaryTargets.map(slimTarget),
    secondaryTargets: secondaryTargets.map(slimTarget),
    supportingCode: supportingCode.map(slimTarget),
    supportingDocs: supportingDocs.map(slimTarget),
    supportingConfig: supportingConfig.map(slimTarget),
    supportingTests: supportingTests.map(slimTarget),
    featureContext: targets.filter(target => target.role === 'feature_plan').map(slimTarget),
    riskNotes: input.located.warnings,
    suggestedReadOrder: targets.map(target => ({
      spanId: target.spanId,
      path: target.path,
      startLine: target.recommendedReadRange.startLine,
      endLine: target.recommendedReadRange.endLine
    })),
    includeSnippets: input.includeSnippets ?? false
  };
}

export async function handleNlContext(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlContextInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const located = await runLocator({
    projectRoot,
    goal: parsed.goal,
    targetRoles: [...DEFAULT_CONTEXT_ROLES],
    limit: 30,
    budget: parsed.budget
  });
  const targets = located.targets;
  const contextData = await buildContextDataFromLocated({
    projectRoot,
    located,
    includeSnippets: parsed.includeSnippets
  });

  return createEnvelope({
    ok: true,
    tool: 'nl_context',
    projectRoot,
    graphRevision: located.graphRevision,
    graphState: located.graphState,
    tokenBudget: located.tokenBudget,
    warnings: located.warnings,
    data: contextData,
    evidence: targets.flatMap(target => target.evidence),
    nextActions: ['read primaryTargets with nl_read_span']
  });
}
