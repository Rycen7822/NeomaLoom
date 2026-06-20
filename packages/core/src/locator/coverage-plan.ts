import type { EnvelopeWarning } from '../mcp/envelope.js';
import { expandRoleAliases, roleMatchesRequest } from '../spans/role-groups.js';
import type { NormalizedQuery } from './query-normalizer.js';
import type { RankedCandidate } from './ranking.js';

export type CoveragePlan = {
  exactSweeps: string[];
  pathRolesToVerify: string[];
  linkedDocsToVerify: string[];
  linkedDocsToVerifyOmitted: number;
  linkedTestsToVerify: string[];
  linkedTestsToVerifyOmitted: number;
  warnings: EnvelopeWarning[];
};

const DOC_ROLES = new Set([
  'canonical_api_doc',
  'readme_doc',
  'quickstart_doc',
  'tutorial_doc',
  'example_doc',
  'paper_doc',
  'design_doc',
  'changelog_doc'
]);

const MAX_COVERAGE_PLAN_LINKED_PATHS = 50;

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function cappedPaths(paths: string[]): { items: string[]; omitted: number } {
  const sorted = uniqueSortedPaths(paths);
  return {
    items: sorted.slice(0, MAX_COVERAGE_PLAN_LINKED_PATHS),
    omitted: Math.max(0, sorted.length - MAX_COVERAGE_PLAN_LINKED_PATHS)
  };
}

export function buildCoveragePlan(input: {
  query: NormalizedQuery;
  targets: RankedCandidate[];
  requestedRoles?: string[];
}): CoveragePlan {
  const roles = [...new Set(input.targets.map(target => String(target.role)))].sort();
  const requestedRoles = [...new Set([...expandRoleAliases(input.requestedRoles ?? []), ...input.query.targetRoles])];
  const existingRequestedRoles = requestedRoles.filter(role => roles.includes(role)).sort();
  const rawRequests = input.requestedRoles && input.requestedRoles.length > 0 ? input.requestedRoles : requestedRoles;
  const missingRequestedRoles = [...new Set(rawRequests)]
    .filter(requested => !roles.some(role => role === requested || roleMatchesRequest(role, [requested])))
    .sort();
  const linkedDocs = cappedPaths(input.targets.filter(target => DOC_ROLES.has(String(target.role))).map(target => target.path));
  const linkedTests = cappedPaths(input.targets.filter(target => target.role === 'test_file').map(target => target.path));

  return {
    exactSweeps: [...new Set([...input.query.oldTerms, ...input.query.newTerms, ...input.query.symbolTerms, ...input.query.configTerms])],
    pathRolesToVerify: existingRequestedRoles.length > 0 ? existingRequestedRoles : roles,
    linkedDocsToVerify: linkedDocs.items,
    linkedDocsToVerifyOmitted: linkedDocs.omitted,
    linkedTestsToVerify: linkedTests.items,
    linkedTestsToVerifyOmitted: linkedTests.omitted,
    warnings: missingRequestedRoles.map(role => ({
      code: 'coverage_missing',
      severity: 'warning' as const,
      message: `${role} was requested but no indexed target matched`
    }))
  };
}
