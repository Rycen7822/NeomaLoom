import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import { verifyCoverage } from '../../verifier/coverage-verifier.js';
import { normalizeProjectRelativePath, safeReadFileInsideProject, safeReaddirInsideProject, safeStatInsideProject } from '../../safety/path-guard.js';
import { readInventorySnapshot } from '../../state/changed-detection.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type EnvelopeWarning, type GraphState, type NoemaLoomEnvelope } from '../envelope.js';

export const nlVerifyCoverageInputSchema = z
  .object({
    projectPath: z.string().optional(),
    goal: z.string().min(1),
    changedPaths: z.array(z.string()).default([]),
    oldTerms: z.array(z.string()).default([]),
    newTerms: z.array(z.string()).default([]),
    oldTermPolicy: z.enum(['changed_paths', 'changed_paths_plus_advisory_docs', 'strict_global']).default('changed_paths_plus_advisory_docs')
  })
  .passthrough();

type CoverageStatus = 'pass' | 'needs_attention' | 'fail';

function toRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

async function collectFilesUnder(projectRoot: string, repoPath: string): Promise<string[]> {
  const entries = await safeReaddirInsideProject(projectRoot, repoPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.noemaloom') {
      continue;
    }
    const childRepoPath = normalizeProjectRelativePath(projectRoot, path.posix.join(repoPath, entry.name));
    if (entry.isDirectory()) {
      files.push(...(await collectFilesUnder(projectRoot, childRepoPath)));
    } else if (entry.isFile()) {
      files.push(childRepoPath);
    }
  }
  return files;
}

async function expandChangedPaths(projectRoot: string, changedPaths: string[]): Promise<string[]> {
  const expanded = new Set<string>();
  for (const rawChangedPath of changedPaths.map(toRepoPath).filter(Boolean)) {
    let changedPath: string;
    try {
      changedPath = normalizeProjectRelativePath(projectRoot, rawChangedPath);
    } catch {
      continue;
    }
    try {
      const fileStat = await safeStatInsideProject(projectRoot, changedPath);
      if (fileStat.isDirectory()) {
        for (const childPath of await collectFilesUnder(projectRoot, changedPath)) {
          expanded.add(childPath);
        }
      } else if (fileStat.isFile()) {
        expanded.add(changedPath);
      }
    } catch {
      expanded.add(changedPath);
    }
  }
  return [...expanded].sort();
}

async function currentHash(projectRoot: string, repoPath: string, expectedHash: string): Promise<string | undefined> {
  try {
    const safeRepoPath = normalizeProjectRelativePath(projectRoot, repoPath);
    const fileStat = await safeStatInsideProject(projectRoot, safeRepoPath);
    if (!fileStat.isFile()) {
      return undefined;
    }
    if (expectedHash.startsWith('oversized:')) {
      return `oversized:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
    }
    return sha1(await safeReadFileInsideProject(projectRoot, safeRepoPath));
  } catch {
    return undefined;
  }
}

async function graphStateForChangedPaths(projectRoot: string, changedPaths: string[]): Promise<GraphState> {
  if (changedPaths.length === 0) {
    return 'ready';
  }
  const snapshot = await readInventorySnapshot(projectRoot);
  if (!snapshot) {
    return 'stale';
  }
  const snapshotByPath = new Map(snapshot.files.map(file => [toRepoPath(file.path), file.contentHash]));
  const expandedPaths = await expandChangedPaths(projectRoot, changedPaths);
  for (const changedPath of expandedPaths) {
    const expectedHash = snapshotByPath.get(changedPath);
    if (!expectedHash) {
      return 'stale';
    }
    if ((await currentHash(projectRoot, changedPath, expectedHash)) !== expectedHash) {
      return 'stale';
    }
  }
  return 'ready';
}

function warningsForStatus(status: CoverageStatus): EnvelopeWarning[] {
  if (status === 'pass') {
    return [];
  }
  return [
    {
      code: status === 'fail' ? 'verify_coverage_failed' : 'verify_coverage_needs_attention',
      severity: status === 'fail' ? 'error' : 'warning',
      message:
        status === 'fail'
          ? 'Coverage verification failed; inspect data.coverage before treating this task as complete.'
          : 'Coverage verification needs attention before this task can be treated as complete.'
    }
  ];
}

function nextActionsFor(status: CoverageStatus, graphState: GraphState): string[] {
  if (status === 'pass') {
    return graphState === 'stale' ? ['nl_refresh(target="changed", mode="safe")'] : [];
  }
  return status === 'fail' ? ['fix reported coverage gaps before refresh'] : ['resolve reported coverage attention before refresh'];
}

export async function handleNlVerifyCoverage(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlVerifyCoverageInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const result = await verifyCoverage({
    projectRoot,
    goal: parsed.goal,
    changedPaths: parsed.changedPaths,
    oldTerms: parsed.oldTerms,
    newTerms: parsed.newTerms,
    oldTermPolicy: parsed.oldTermPolicy
  });

  const graphState = await graphStateForChangedPaths(projectRoot, parsed.changedPaths);

  return createEnvelope({
    ok: result.status === 'pass',
    tool: 'nl_verify_coverage',
    projectRoot,
    graphRevision,
    graphState,
    tokenBudget: {
      requested: 2500,
      used: Math.ceil(JSON.stringify(result).length / 4),
      truncated: false
    },
    warnings: warningsForStatus(result.status),
    data: result,
    nextActions: nextActionsFor(result.status, graphState)
  });
}
