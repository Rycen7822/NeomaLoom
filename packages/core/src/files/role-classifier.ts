import path from 'node:path';

import type { FileRole } from '../spans/enums.js';

function normalize(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function classifyFileRole(repoPath: string): FileRole {
  const normalized = normalize(repoPath);
  const basename = path.posix.basename(normalized);

  if (basename === 'README.md') return 'readme_doc';
  if (basename === 'CHANGELOG.md') return 'changelog_doc';
  if (normalized.startsWith('docs/api/') || normalized.startsWith('docs/reference/')) {
    return 'canonical_api_doc';
  }
  if (/^docs\/tutorial[^/]*\//.test(normalized)) return 'tutorial_doc';
  if (normalized.startsWith('examples/')) return 'example_doc';
  if (normalized.startsWith('paper/')) return 'paper_doc';
  if (normalized.startsWith('notes/') || normalized.startsWith('experiments/')) return 'experiment_note_doc';
  if (normalized.startsWith('design/') || normalized.startsWith('docs/design/')) return 'design_doc';
  if (normalized.startsWith('src/') || normalized.startsWith('lib/') || /^packages\/[^/]+\/src\//.test(normalized)) {
    return 'source_file';
  }
  if (normalized.startsWith('test/') || normalized.startsWith('tests/') || normalized.startsWith('__tests__/')) {
    return 'test_file';
  }
  if (normalized.startsWith('fixtures/')) return 'fixture_file';
  if (normalized.endsWith('.schema.json')) return 'schema_file';
  if (basename === 'package.json' || basename === 'pyproject.toml') return 'package_metadata';
  if (normalized.startsWith('dist/') || normalized.startsWith('build/') || normalized.startsWith('coverage/')) {
    return 'generated_file';
  }
  if (normalized.startsWith('vendor/')) return 'vendor_file';
  if (normalized.startsWith('features/')) return 'feature_plan';
  if (['.json', '.yaml', '.yml', '.toml'].includes(path.posix.extname(normalized))) {
    return 'config_file';
  }

  return 'unknown';
}
