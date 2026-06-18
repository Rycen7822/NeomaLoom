import type { EnvelopeWarning } from '../mcp/envelope.js';
import type { NormalizedQuery } from './query-normalizer.js';
import type { RankedCandidate } from './ranking.js';

export type CoveragePlan = {
  exactSweeps: string[];
  pathRolesToVerify: string[];
  linkedDocsToVerify: string[];
  linkedTestsToVerify: string[];
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

export function buildCoveragePlan(input: {
  query: NormalizedQuery;
  targets: RankedCandidate[];
  requestedRoles?: string[];
}): CoveragePlan {
  const roles = [...new Set(input.targets.map(target => String(target.role)))].sort();
  const requestedRoles = [...new Set([...(input.requestedRoles ?? []), ...input.query.targetRoles])];
  const existingRequestedRoles = requestedRoles.filter(role => roles.includes(role)).sort();
  const missingRequestedRoles = requestedRoles.filter(role => !roles.includes(role)).sort();

  return {
    exactSweeps: [...new Set([...input.query.oldTerms, ...input.query.newTerms, ...input.query.symbolTerms, ...input.query.configTerms])],
    pathRolesToVerify: existingRequestedRoles.length > 0 ? existingRequestedRoles : roles,
    linkedDocsToVerify: [...new Set(input.targets.filter(target => DOC_ROLES.has(String(target.role))).map(target => target.path))].sort(),
    linkedTestsToVerify: [...new Set(input.targets.filter(target => target.role === 'test_file').map(target => target.path))].sort(),
    warnings: missingRequestedRoles.map(role => ({
      code: 'coverage_missing',
      severity: 'warning' as const,
      message: `${role} was requested but no indexed target matched`
    }))
  };
}
