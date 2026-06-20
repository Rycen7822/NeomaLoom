import { FILE_ROLES, type FileRole } from './enums.js';

const ROLE_GROUPS: Record<string, FileRole[]> = {
  source: ['source_file'],
  code: ['source_file'],
  test: ['test_file', 'fixture_file'],
  tests: ['test_file', 'fixture_file'],
  fixture: ['fixture_file'],
  config: ['config_file', 'schema_file', 'package_metadata'],
  configuration: ['config_file', 'schema_file', 'package_metadata'],
  doc: ['canonical_api_doc', 'tutorial_doc', 'quickstart_doc', 'example_doc', 'paper_doc', 'experiment_note_doc', 'changelog_doc', 'design_doc', 'readme_doc'],
  docs: ['canonical_api_doc', 'tutorial_doc', 'quickstart_doc', 'example_doc', 'paper_doc', 'experiment_note_doc', 'changelog_doc', 'design_doc', 'readme_doc'],
  document: ['canonical_api_doc', 'tutorial_doc', 'quickstart_doc', 'example_doc', 'paper_doc', 'experiment_note_doc', 'changelog_doc', 'design_doc', 'readme_doc'],
  documentation: ['canonical_api_doc', 'tutorial_doc', 'quickstart_doc', 'example_doc', 'paper_doc', 'experiment_note_doc', 'changelog_doc', 'design_doc', 'readme_doc'],
  example: ['example_doc'],
  examples: ['example_doc'],
  feature: ['feature_plan'],
  features: ['feature_plan']
};

const KNOWN_ROLES = new Set<string>(FILE_ROLES);

export function expandRoleAliases(roles: readonly string[] = []): FileRole[] {
  const expanded: FileRole[] = [];
  for (const role of roles) {
    const key = role.trim().toLowerCase();
    const mapped = ROLE_GROUPS[key];
    if (mapped) {
      expanded.push(...mapped);
    } else if (KNOWN_ROLES.has(role)) {
      expanded.push(role as FileRole);
    }
  }
  return [...new Set(expanded)];
}

export function roleMatchesRequest(role: string, requested: readonly string[] = []): boolean {
  if (requested.length === 0) {
    return false;
  }
  return expandRoleAliases(requested).includes(role as FileRole);
}

export function roleGroupName(role: string): 'source' | 'test' | 'config' | 'document' | 'feature' | 'other' {
  if (role === 'source_file') return 'source';
  if (role === 'test_file' || role === 'fixture_file') return 'test';
  if (role === 'config_file' || role === 'schema_file' || role === 'package_metadata') return 'config';
  if (role.endsWith('_doc')) return 'document';
  if (role === 'feature_plan') return 'feature';
  return 'other';
}
