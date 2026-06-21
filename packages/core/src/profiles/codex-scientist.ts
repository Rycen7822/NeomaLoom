import path from 'node:path';

import type { InventoryFile } from '../files/file-inventory.js';
import { safeReadFileInsideProject } from '../safety/path-guard.js';

export type EditBoundary = {
  editable: boolean;
  warning?: string;
};

const COLD_PATTERNS: RegExp[] = [
  /(^|\/)resources\/code\/github\//,
  /(^|\/)\.ds\/bash_exec\//,
  /(^|\/)experiments\/stage[^/]*\/.*\/runs\//,
  /(^|\/)runs\//,
  /\.(jsonl|csv|log)$/i,
  /(^|\/)(checkpoints?|models?|cache|\.cache)\//i,
  /(^|\/)(planning|archive|archives)\//i
];

const STATIC_SEED_PATTERNS: RegExp[] = [
  /^CODEX_STATE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/experiments\/CURRENT_STATUS\.md$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/experiments\/EXPERIMENT_EXECUTION_PLAN\.md$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/experiments\/正式实验命令\.md$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/STAGE[^/]*推进.*\.md$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/experiments\/stage[^/]+\/00_freeze\/.*STATE.*\.json$/,
  /(^|\/)DeepScientist\/quests\/[^/]+\/experiments\/stage[^/]+\/scripts\/[^/]+\.(py|ts|js|sh)$/
];

function normalize(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function isCodexScientistColdPath(repoPath: string): boolean {
  const normalized = normalize(repoPath);
  return COLD_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isCodexScientistWorkspace(files: InventoryFile[]): boolean {
  const paths = new Set(files.map(file => file.path));
  return paths.has('CODEX_STATE.md') && [...paths].some(repoPath => /(^|\/)DeepScientist\/quests\/[^/]+\/AGENTS\.md$/.test(repoPath));
}

export function codexScientistEditBoundary(repoPath: string): EditBoundary {
  const normalized = normalize(repoPath);
  if (/(EXPERIMENT_EXECUTION_PLAN|正式实验命令|CURRENT_STATUS|CODEX_STATE|AGENTS)\.md$/.test(normalized)) {
    return {
      editable: false,
      warning: 'Hot-indexed Codex/DeepScientist anchor; read/searchable by default, but edit only when the user explicitly asks.'
    };
  }
  if (/(^|\/)(planning|archive|archives|recommendations?|suggestions?|directions?)\//i.test(normalized)) {
    return {
      editable: false,
      warning: 'Planning/archive/direction file; hotset membership does not grant edit permission.'
    };
  }
  return { editable: true };
}

function extractPathTokens(markdown: string): string[] {
  const tokens = new Set<string>();
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    tokens.add(match[1]);
  }
  for (const match of markdown.matchAll(/(?:^|[\s*\-])((?:\.?\.?\/)?[\w.\-\u4e00-\u9fff/]+\.(?:md|mdx|rst|py|ts|js|json|yaml|yml|toml|sh))/gim)) {
    tokens.add(match[1]);
  }
  return [...tokens]
    .map(token => token.split('#')[0]?.trim() ?? '')
    .filter(token => token.length > 0 && !/[\s]/.test(token) && !token.includes('$('));
}

function resolveToken(token: string, sourcePath: string, knownPaths: Set<string>): string | undefined {
  const cleaned = normalize(token);
  if (knownPaths.has(cleaned)) {
    return cleaned;
  }
  const relative = normalize(path.posix.join(path.posix.dirname(sourcePath), cleaned));
  if (knownPaths.has(relative)) {
    return relative;
  }
  return undefined;
}

async function readSeedReferences(projectRoot: string, seedFile: InventoryFile, knownPaths: Set<string>): Promise<string[]> {
  if (seedFile.oversized || !['markdown', 'mdx', 'rst'].includes(seedFile.language)) {
    return [];
  }
  try {
    const text = await safeReadFileInsideProject(projectRoot, seedFile.path, 'utf8');
    return extractPathTokens(text)
      .map(token => resolveToken(token, seedFile.path, knownPaths))
      .filter((repoPath): repoPath is string => Boolean(repoPath));
  } catch {
    return [];
  }
}

export async function detectCodexScientistHotsetSeedPaths(projectRoot: string, files: InventoryFile[]): Promise<string[]> {
  if (!isCodexScientistWorkspace(files)) {
    return [];
  }
  const knownPaths = new Set(files.map(file => file.path));
  const seedPaths = new Set(
    files
      .filter(file => !isCodexScientistColdPath(file.path) && STATIC_SEED_PATTERNS.some(pattern => pattern.test(file.path)))
      .map(file => file.path)
  );

  const readableSeeds = files.filter(file => seedPaths.has(file.path) && ['markdown', 'mdx', 'rst'].includes(file.language));
  for (const seedFile of readableSeeds) {
    for (const referencedPath of await readSeedReferences(projectRoot, seedFile, knownPaths)) {
      if (!isCodexScientistColdPath(referencedPath)) {
        seedPaths.add(referencedPath);
      }
    }
  }

  return [...seedPaths].sort();
}
