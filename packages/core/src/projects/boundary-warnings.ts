import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { EnvelopeWarning } from '../mcp/envelope.js';

async function existsInside(projectRoot: string, repoPath: string): Promise<boolean> {
  try {
    await stat(path.join(projectRoot, repoPath));
    return true;
  } catch {
    return false;
  }
}

export async function detectProjectBoundaryWarnings(projectRoot: string): Promise<EnvelopeWarning[]> {
  const warnings: EnvelopeWarning[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(projectRoot, { withFileTypes: true, encoding: 'utf8' }) as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return warnings;
  }

  const childProjects: string[] = [];
  const noiseDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ['.git', '.noemaloom', 'node_modules'].includes(entry.name)) continue;
    if (
      ['artifact', 'artifacts', 'backups', 'hermes-plugin-backups', 'token_efficiency_benchmark'].includes(entry.name) ||
      entry.name.endsWith('-backups') ||
      entry.name.endsWith('_runs')
    ) {
      noiseDirs.push(entry.name);
    }
    const child = entry.name;
    if (
      await existsInside(projectRoot, path.join(child, 'package.json')) ||
      await existsInside(projectRoot, path.join(child, 'pyproject.toml')) ||
      await existsInside(projectRoot, path.join(child, '.git')) ||
      await existsInside(projectRoot, path.join(child, '.noemaloom'))
    ) {
      childProjects.push(child);
    }
  }

  if (childProjects.length >= 2) {
    warnings.push({
      code: 'multi_project_root_suspected',
      severity: 'warning',
      message: `Project path contains multiple child project roots (${childProjects.slice(0, 8).join(', ')}); pass the intended subproject as projectPath for ranking-sensitive queries.`
    });
  }
  if (noiseDirs.length > 0) {
    warnings.push({
      code: 'artifact_or_backup_noise_detected',
      severity: 'warning',
      message: `Project path contains artifact/backup directories (${noiseDirs.slice(0, 8).join(', ')}); prefer a narrower projectPath if these are not part of the active code/doc/config surface.`
    });
  }
  return warnings;
}
