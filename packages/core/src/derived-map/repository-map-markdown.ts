import type { RepositoryMap } from './repository-map.js';

function listOrNone(lines: string[]): string[] {
  return lines.length > 0 ? lines : ['- none'];
}

export function renderRepositoryMapMarkdown(map: RepositoryMap): string {
  const lines = [
    '# Repository Map',
    '',
    `Graph revision: ${map.graphRevision}`,
    '',
    '## Directory Roles',
    ...listOrNone(map.directoryRoles.map(entry => `- \`${entry.path}\`: ${entry.roles.join(', ')} (${entry.spanCount})`)),
    '',
    '## Canonical Docs',
    ...listOrNone(map.canonicalDocs.map(entry => `- \`${entry.path}\`: ${entry.label} [${entry.role}]`)),
    '',
    '## Core Source Modules',
    ...listOrNone(map.coreSourceModules.map(entry => `- \`${entry.path}\`: ${entry.label} [${entry.kind}]`)),
    '',
    '## Test Entries',
    ...listOrNone(map.testEntries.map(entry => `- \`${entry.path}\`: ${entry.label} [${entry.kind}]`)),
    '',
    '## Config Entries',
    ...listOrNone(map.configEntries.map(entry => `- \`${entry.path}\`: ${entry.label} [${entry.kind}]`)),
    '',
    '## Feature Clusters',
    ...listOrNone(
      map.featureClusters.map(entry => `- ${entry.label} (${entry.id}): ${entry.linkedSpanIds.join(', ') || 'no linked spans'}`)
    ),
    '',
    '## High Confidence Links',
    ...listOrNone(
      map.highConfidenceLinks.map(
        entry =>
          `- ${entry.sourceSpanId} -> ${entry.targetSpanId} [${entry.relation}, ${entry.confidence.toFixed(2)}, ${entry.evidenceKind}]`
      )
    ),
    '',
    '## Warnings',
    ...listOrNone(map.warnings.map(warning => `- ${warning}`)),
    ''
  ];

  return `${lines.join('\n')}`;
}
