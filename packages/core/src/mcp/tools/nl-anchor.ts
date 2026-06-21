import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  createEmptyWorksetManifest,
  readWorksetManifest,
  renderNavigationCards,
  retireAnchor,
  setNavigationEnabled,
  updateAnchorState,
  upsertNavigationTargets,
  worksetRevision,
  writeWorksetManifest,
  type NavigationAnchor,
  type NavigationAnchorLifecycleState,
  type WorksetManifest
} from '../../state/workset.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

const anchorSelectorSchema = z.object({
  projectPath: z.string().optional(),
  anchorId: z.string().optional(),
  path: z.string().optional(),
  reason: z.string().default('agent curation')
}).passthrough();

export const nlAnchorStatusInputSchema = z.object({
  projectPath: z.string().optional(),
  includeRetired: z.boolean().default(false),
  includeText: z.boolean().default(true),
  responseProfile: z.enum(['compact', 'standard', 'debug']).default('compact')
}).passthrough();

export const nlAnchorManageInputSchema = z.object({
  action: z.enum(['promote', 'demote']),
  projectPath: z.string().optional(),
  anchorId: z.string().optional(),
  path: z.string().optional(),
  label: z.string().optional(),
  kind: z.string().optional(),
  role: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  reason: z.string().optional(),
  pinned: z.boolean().optional(),
  state: z.enum(['dormant', 'archived']).optional()
}).passthrough();

export const nlAnchorPromoteInputSchema = z.object({
  projectPath: z.string().optional(),
  path: z.string().min(1),
  label: z.string().optional(),
  kind: z.string().default('file'),
  role: z.string().default('source_file'),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  reason: z.string().default('agent promoted anchor'),
  pinned: z.boolean().default(false),
  enableNavigation: z.boolean().optional()
}).passthrough();

export const nlAnchorDemoteInputSchema = anchorSelectorSchema.extend({
  state: z.enum(['dormant', 'archived']).default('dormant')
});

export const nlAnchorRetireInputSchema = anchorSelectorSchema;

export const nlAnchorRepairInputSchema = anchorSelectorSchema.extend({
  newPath: z.string().optional(),
  label: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  kind: z.string().optional(),
  role: z.string().optional()
});

export const nlAnchorCheckpointInputSchema = z.object({
  projectPath: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(['silent', 'inject']).optional(),
  reason: z.string().default('agent checkpoint')
}).passthrough();

function publicAnchors(manifest: WorksetManifest, includeRetired: boolean): NavigationAnchor[] {
  return manifest.anchors
    .filter(anchor => includeRetired || !['retired', 'tombstoned'].includes(anchor.state))
    .map(anchor => ({ ...anchor, tombstoneReason: anchor.tombstoneReason }));
}

export function anchorGraphStateFor(manifest: WorksetManifest): 'empty' | 'ready' {
  return manifest.anchors.length > 0 || manifest.tombstones.length > 0 ? 'ready' : 'empty';
}

function findAnchor(manifest: WorksetManifest, selector: { anchorId?: string; path?: string }): NavigationAnchor | undefined {
  if (selector.anchorId) return manifest.anchors.find(anchor => anchor.id === selector.anchorId);
  if (selector.path) return manifest.anchors.find(anchor => anchor.path === selector.path);
  return undefined;
}

function selectorWarning(selector: { anchorId?: string; path?: string }) {
  return {
    code: 'anchor_not_found',
    severity: 'warning' as const,
    message: selector.anchorId ? `No navigation anchor found for id ${selector.anchorId}.` : `No navigation anchor found for path ${selector.path ?? '<missing>'}.`
  };
}

function pathWarning(code: string, message: string) {
  return {
    code,
    severity: 'warning' as const,
    message
  };
}

async function validateAnchorProjectPath(projectRoot: string, repoPath: string) {
  if (path.isAbsolute(repoPath)) {
    return pathWarning('anchor_path_outside_project', `Navigation anchor path must be project-relative: ${repoPath}`);
  }

  const absolutePath = path.resolve(projectRoot, repoPath);
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return pathWarning('anchor_path_outside_project', `Navigation anchor path escapes project root: ${repoPath}`);
  }

  const parts = relative.split(path.sep).filter(Boolean);
  if (parts[0] === '.noemaloom') {
    return pathWarning('anchor_path_forbidden', `Navigation anchors cannot target NoemaLoom state files: ${repoPath}`);
  }

  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return pathWarning('anchor_path_not_found', `Navigation anchor path does not exist: ${repoPath}`);
    }
    throw error;
  }

  if (!stat.isFile()) {
    return pathWarning('anchor_path_not_file', `Navigation anchor path must point to a regular file: ${repoPath}`);
  }

  return undefined;
}

function anchorMatchesInput(anchor: NavigationAnchor, input: { path: string; kind?: string; startLine?: number; endLine?: number }): boolean {
  return anchor.path === input.path &&
    anchor.kind === (input.kind ?? anchor.kind) &&
    anchor.startLine === input.startLine &&
    anchor.endLine === input.endLine;
}

export function anchorStatusData(manifest: WorksetManifest, includeRetired: boolean, includeText: boolean): Record<string, unknown> {
  const rendered = renderNavigationCards(manifest, { includeDisabled: true });
  return {
    revision: worksetRevision(manifest),
    enabled: manifest.options.navigation.enabled,
    mode: manifest.options.navigation.mode,
    counters: manifest.counters,
    budgets: manifest.budgets,
    counts: {
      anchors: manifest.anchors.length,
      active: manifest.anchors.filter(anchor => anchor.state === 'active').length,
      dormant: manifest.anchors.filter(anchor => anchor.state === 'dormant').length,
      archived: manifest.anchors.filter(anchor => anchor.state === 'archived').length,
      tombstones: manifest.tombstones.length
    },
    anchors: publicAnchors(manifest, includeRetired),
    tombstones: manifest.tombstones,
    navigation: {
      cards: rendered.cards,
      text: includeText ? rendered.text : '',
      charBudget: rendered.charBudget,
      truncated: rendered.truncated
    }
  };
}

async function writeAndReturn(tool: string, projectRoot: string, manifest: WorksetManifest, includeRetired = false): Promise<NoemaLoomEnvelope> {
  await writeWorksetManifest(projectRoot, manifest);
  return createEnvelope({
    ok: true,
    tool,
    projectRoot,
    graphRevision: worksetRevision(manifest),
    graphState: anchorGraphStateFor(manifest),
    data: anchorStatusData(manifest, includeRetired, true)
  });
}

export async function handleNlAnchorStatus(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorStatusInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const manifest = await readWorksetManifest(projectRoot);
  return createEnvelope({
    ok: true,
    tool: 'nl_anchor_status',
    projectRoot,
    graphRevision: worksetRevision(manifest),
    graphState: anchorGraphStateFor(manifest),
    data: anchorStatusData(manifest, parsed.includeRetired, parsed.includeText)
  });
}

export async function handleNlAnchorPromote(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorPromoteInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  let manifest = await readWorksetManifest(projectRoot);
  const validationWarning = await validateAnchorProjectPath(projectRoot, parsed.path);
  if (validationWarning) {
    return createEnvelope({
      ok: false,
      tool: 'nl_anchor_promote',
      projectRoot,
      graphRevision: worksetRevision(manifest),
      graphState: anchorGraphStateFor(manifest),
      warnings: [validationWarning],
      data: anchorStatusData(manifest, true, true)
    });
  }

  manifest = upsertNavigationTargets({
    manifest,
    source: 'agent_curated',
    reason: parsed.reason,
    maxTargets: 1,
    preserveCurated: false,
    targets: [
      {
        path: parsed.path,
        label: parsed.label ?? parsed.path,
        kind: parsed.kind,
        role: parsed.role,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        score: 100,
        confidence: 1,
        reason: parsed.reason
      }
    ]
  });
  if (parsed.pinned) {
    manifest = {
      ...manifest,
      anchors: manifest.anchors.map(anchor => anchorMatchesInput(anchor, parsed)
        ? { ...anchor, pinned: true }
        : anchor)
    };
  }
  if (typeof parsed.enableNavigation === 'boolean') {
    manifest = setNavigationEnabled(manifest, parsed.enableNavigation);
  }
  return writeAndReturn('nl_anchor_promote', projectRoot, manifest);
}

export async function handleNlAnchorDemote(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorDemoteInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const manifest = await readWorksetManifest(projectRoot);
  const anchor = findAnchor(manifest, parsed);
  if (!anchor) {
    return createEnvelope({
      ok: false,
      tool: 'nl_anchor_demote',
      projectRoot,
      graphRevision: worksetRevision(manifest),
      graphState: anchorGraphStateFor(manifest),
      warnings: [selectorWarning(parsed)],
      data: anchorStatusData(manifest, true, true)
    });
  }
  return writeAndReturn('nl_anchor_demote', projectRoot, updateAnchorState(manifest, anchor.id, parsed.state, parsed.reason));
}

export async function handleNlAnchorManage(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorManageInputSchema.parse(input ?? {});
  const result = parsed.action === 'promote'
    ? await handleNlAnchorPromote({
        ...parsed,
        reason: parsed.reason ?? 'agent promoted anchor'
      })
    : await handleNlAnchorDemote({
        ...parsed,
        state: parsed.state ?? 'dormant',
        reason: parsed.reason ?? 'agent curation'
      });
  return {
    ...result,
    tool: 'nl_anchor_manage'
  };
}

export async function handleNlAnchorRetire(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorRetireInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const manifest = await readWorksetManifest(projectRoot);
  const anchor = findAnchor(manifest, parsed);
  if (!anchor) {
    return createEnvelope({
      ok: false,
      tool: 'nl_anchor_retire',
      projectRoot,
      graphRevision: worksetRevision(manifest),
      graphState: anchorGraphStateFor(manifest),
      warnings: [selectorWarning(parsed)],
      data: anchorStatusData(manifest, true, true)
    });
  }
  return writeAndReturn('nl_anchor_retire', projectRoot, retireAnchor(manifest, anchor.id, parsed.reason), true);
}

export async function handleNlAnchorRepair(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorRepairInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const manifest = await readWorksetManifest(projectRoot);
  const anchor = findAnchor(manifest, parsed);
  if (!anchor) {
    return createEnvelope({
      ok: false,
      tool: 'nl_anchor_repair',
      projectRoot,
      graphRevision: worksetRevision(manifest),
      graphState: anchorGraphStateFor(manifest),
      warnings: [selectorWarning(parsed)],
      data: anchorStatusData(manifest, true, true)
    });
  }
  if (parsed.newPath) {
    const validationWarning = await validateAnchorProjectPath(projectRoot, parsed.newPath);
    if (validationWarning) {
      return createEnvelope({
        ok: false,
        tool: 'nl_anchor_repair',
        projectRoot,
        graphRevision: worksetRevision(manifest),
        graphState: anchorGraphStateFor(manifest),
        warnings: [validationWarning],
        data: anchorStatusData(manifest, true, true)
      });
    }
  }
  const nextCounters = {
    ...manifest.counters,
    projectActivitySeq: manifest.counters.projectActivitySeq + 1
  };
  const next: WorksetManifest = {
    ...manifest,
    counters: nextCounters,
    anchors: manifest.anchors.map(candidate => candidate.id === anchor.id
      ? {
          ...candidate,
          path: parsed.newPath ?? candidate.path,
          label: parsed.label ?? candidate.label,
          startLine: parsed.startLine ?? candidate.startLine,
          endLine: parsed.endLine ?? candidate.endLine,
          kind: parsed.kind ?? candidate.kind,
          role: parsed.role ?? candidate.role,
          state: 'active' as NavigationAnchorLifecycleState,
          source: 'agent_curated' as const,
          reason: parsed.reason,
          updatedAt: new Date().toISOString(),
          lastSeenSeq: nextCounters.projectActivitySeq
        }
      : candidate)
  };
  return writeAndReturn('nl_anchor_repair', projectRoot, next);
}

export async function handleNlAnchorCheckpoint(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlAnchorCheckpointInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  let manifest = await readWorksetManifest(projectRoot);
  if (manifest.version !== 1) manifest = createEmptyWorksetManifest(projectRoot);
  if (typeof parsed.enabled === 'boolean' || parsed.mode) {
    manifest = setNavigationEnabled(manifest, parsed.enabled ?? manifest.options.navigation.enabled, parsed.mode ?? manifest.options.navigation.mode);
  }
  manifest = {
    ...manifest,
    counters: {
      ...manifest.counters,
      projectActivitySeq: manifest.counters.projectActivitySeq + 1
    }
  };
  return writeAndReturn('nl_anchor_checkpoint', projectRoot, manifest);
}
