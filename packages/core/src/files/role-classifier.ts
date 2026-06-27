import path from 'node:path';

import type { FileRole } from '../spans/enums.js';
import { classifyPathLayer } from './path-layer.js';

function normalize(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.vue', '.svelte'
]);

export function isGeneratedArtifactPath(repoPath: string): boolean {
  const normalized = normalize(repoPath);
  const extension = path.posix.extname(normalized).toLowerCase();
  const layer = classifyPathLayer(normalized);
  return (
    layer === 'generated' ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('build/') ||
    normalized.startsWith('coverage/') ||
    normalized === '__pycache__' ||
    normalized.startsWith('__pycache__/') ||
    normalized.includes('/__pycache__/') ||
    extension === '.pyc' ||
    extension === '.pyo'
  );
}

function hasPathSegment(normalized: string, names: string[]): boolean {
  const parts = normalized.split('/');
  return parts.some(part => names.includes(part));
}

function isCodePath(normalized: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function isTestCodePath(normalized: string, basename: string): boolean {
  if (!isCodePath(normalized)) return false;
  return (
    hasPathSegment(normalized, ['test', 'tests', '__tests__']) ||
    /^test[_-]/i.test(basename) ||
    /[._-](test|spec)\.[^.]+$/i.test(basename)
  );
}

export function classifyFileRole(repoPath: string): FileRole {
  const normalized = normalize(repoPath);
  const basename = path.posix.basename(normalized);

  if (isGeneratedArtifactPath(normalized)) return 'generated_file';
  if (basename === 'README.md') return 'readme_doc';
  if (basename === 'CHANGELOG.md') return 'changelog_doc';
  if (normalized.startsWith('docs/api/') || normalized.startsWith('docs/reference/')) {
    return 'canonical_api_doc';
  }
  if (/^docs\/tutorial[^/]*\//.test(normalized)) return 'tutorial_doc';
  if (normalized.includes('/resources/code/') || normalized.startsWith('resources/code/')) return 'vendor_file';
  if (normalized.startsWith('vendor/')) return 'vendor_file';
  if (normalized.startsWith('examples/')) return 'example_doc';
  if (normalized.startsWith('paper/')) return 'paper_doc';
  if (normalized.startsWith('fixtures/')) return 'fixture_file';
  if (isTestCodePath(normalized, basename)) return 'test_file';
  if (normalized.startsWith('src/') || normalized.startsWith('lib/') || /^packages\/[^/]+\/src\//.test(normalized)) {
    return 'source_file';
  }
  if (isCodePath(normalized) && !normalized.includes('/.ds/')) return 'source_file';
  if (normalized.startsWith('notes/') || normalized.startsWith('experiments/') || normalized.includes('/experiments/') || normalized.includes('/.ds/')) return 'experiment_note_doc';
  if (normalized.startsWith('design/') || normalized.startsWith('docs/design/')) return 'design_doc';
  if (normalized.startsWith('test/') || normalized.startsWith('tests/') || normalized.startsWith('__tests__/')) {
    return 'test_file';
  }
  if (normalized.endsWith('.schema.json')) return 'schema_file';
  if (basename === 'package.json' || basename === 'pyproject.toml') return 'package_metadata';
  if (normalized.startsWith('features/')) return 'feature_plan';
  if (['.json', '.yaml', '.yml', '.toml'].includes(path.posix.extname(normalized))) {
    return 'config_file';
  }
  if (['.md', '.mdx', '.rst'].includes(path.posix.extname(normalized))) {
    return 'design_doc';
  }

  return 'unknown';
}
