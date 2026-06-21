import { createHash } from 'node:crypto';
import { readFile, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { appendFileInsideStateDir, openExclusiveFileInsideStateDir, unlinkInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from './state-dir.js';
import { resolveNoemaLoomPaths } from './paths.js';

export type NavigationAnchorLifecycleState = 'active' | 'dormant' | 'archived' | 'retired' | 'tombstoned';

export type NavigationAnchor = {
  id: string;
  path: string;
  label: string;
  kind: string;
  role: string;
  startLine?: number;
  endLine?: number;
  headingPath: string[];
  state: NavigationAnchorLifecycleState;
  pinned: boolean;
  source: 'nl_prepare_context' | 'agent_curated' | 'checkpoint' | 'imported';
  reason: string;
  score: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  lastSeenSeq: number;
  lastInjectedSeq?: number;
  lastUsefulSeq?: number;
  ignoredInjectionCount: number;
  usefulHitCount: number;
  tombstoneReason?: string;
};

export type WorksetBudgets = {
  activeMax: number;
  activeHardMax: number;
  pinnedMax: number;
  pinnedHardMax: number;
  perPathMax: number;
  perPathHardMax: number;
  coldArchiveMax: number;
  coldArchiveHardMax: number;
  injectionDefaultAnchors: number;
  injectionDefaultChars: number;
  injectionMinimalAnchors: number;
  injectionMinimalChars: number;
  injectionMultisurfaceAnchors: number;
  injectionMultisurfaceChars: number;
  injectionDebugAnchors: number;
  injectionDebugChars: number;
};

export type WorksetCounters = {
  projectActivitySeq: number;
  navigationQuerySeq: number;
  anchorInjectionSeq: number;
  readWriteSeq: number;
};

export type WorksetOptions = {
  navigation: {
    enabled: boolean;
    mode: 'silent' | 'inject';
  };
};

export type WorksetManifest = {
  version: 1;
  projectRootHash: string;
  counters: WorksetCounters;
  budgets: WorksetBudgets;
  options: WorksetOptions;
  anchors: NavigationAnchor[];
  tombstones: Array<{ id: string; path: string; reason: string; tombstonedAt: string; tombstonedSeq: number }>;
};

export type NavigationTargetLike = {
  spanId?: string;
  path?: string;
  kind?: string;
  role?: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  headingPath?: unknown;
  score?: number;
  confidence?: number;
  decision?: string;
  reason?: string;
  indexed?: boolean;
};

export type NavigationCard = {
  id: string;
  path: string;
  label: string;
  kind: string;
  role: string;
  lines?: string;
  reason: string;
  state: NavigationAnchorLifecycleState;
  pinned: boolean;
};

export type RenderNavigationOptions = {
  profile?: 'minimal' | 'default' | 'multisurface' | 'debug';
  maxAnchors?: number;
  charBudget?: number;
  includeDisabled?: boolean;
  includeDormant?: boolean;
};

const DEFAULT_BUDGETS: WorksetBudgets = {
  activeMax: 64,
  activeHardMax: 128,
  pinnedMax: 16,
  pinnedHardMax: 32,
  perPathMax: 2,
  perPathHardMax: 4,
  coldArchiveMax: 256,
  coldArchiveHardMax: 512,
  injectionDefaultAnchors: 3,
  injectionDefaultChars: 650,
  injectionMinimalAnchors: 2,
  injectionMinimalChars: 360,
  injectionMultisurfaceAnchors: 5,
  injectionMultisurfaceChars: 1100,
  injectionDebugAnchors: 10,
  injectionDebugChars: 3000
};

const DEFAULT_COUNTERS: WorksetCounters = {
  projectActivitySeq: 0,
  navigationQuerySeq: 0,
  anchorInjectionSeq: 0,
  readWriteSeq: 0
};

const DEFAULT_OPTIONS: WorksetOptions = {
  navigation: {
    enabled: false,
    mode: 'silent'
  }
};

const WORKSET_LOCK_TTL_MS = 30_000;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function worksetLockPath(projectRoot: string): string {
  return path.join(resolveNoemaLoomPaths(projectRoot).worksetDir, 'anchors.json.lock');
}

function lockExpired(raw: string, now = Date.now()): boolean {
  const parts = raw.trim().split(/\s+/);
  const timestamp = Number(parts[1]);
  return !Number.isFinite(timestamp) || now - timestamp * 1000 > WORKSET_LOCK_TTL_MS;
}

async function removeStaleWorksetLock(projectRoot: string, lockFile: string): Promise<boolean> {
  let raw = '';
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch (error) {
    return isErrnoException(error) && error.code === 'ENOENT';
  }
  if (!lockExpired(raw)) {
    return false;
  }
  try {
    await unlinkInsideStateDir(projectRoot, lockFile);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function acquireWorksetLock(projectRoot: string, lockFile: string): Promise<FileHandle | undefined> {
  try {
    return await openExclusiveFileInsideStateDir(projectRoot, lockFile);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  }
}

async function withWorksetLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const paths = await ensureStateDir(projectRoot);
  const lockFile = worksetLockPath(paths.projectRoot);
  const deadline = Date.now() + 2_000;
  let lockHandle: FileHandle | undefined;
  while (!lockHandle && Date.now() <= deadline) {
    lockHandle = await acquireWorksetLock(paths.projectRoot, lockFile);
    if (!lockHandle && (await removeStaleWorksetLock(paths.projectRoot, lockFile))) {
      lockHandle = await acquireWorksetLock(paths.projectRoot, lockFile);
    }
    if (!lockHandle) {
      await delay(25);
    }
  }
  if (!lockHandle) {
    throw new Error('workset_lock_busy');
  }
  try {
    await lockHandle.writeFile(`${process.pid} ${Date.now() / 1000}\n`);
    return await task();
  } finally {
    await lockHandle.close();
    try {
      await unlinkInsideStateDir(paths.projectRoot, lockFile);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function projectRootHash(projectRoot: string): string {
  return sha1(path.resolve(projectRoot)).slice(0, 16);
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeState(value: unknown): NavigationAnchorLifecycleState {
  return value === 'dormant' || value === 'archived' || value === 'retired' || value === 'tombstoned'
    ? value
    : 'active';
}

function anchorIdFor(target: Pick<NavigationTargetLike, 'spanId' | 'path' | 'startLine' | 'endLine' | 'kind'>): string {
  const stable = target.spanId || `${target.path ?? 'unknown'}:${target.startLine ?? ''}:${target.endLine ?? ''}:${target.kind ?? ''}`;
  return `nav-${sha1(stable).slice(0, 16)}`;
}

export function normalizeNavigationAnchorPath(repoPath: string): string | undefined {
  const normalized = path.posix.normalize(repoPath.replaceAll('\\', '/'));
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return undefined;
  }
  const firstSegment = normalized.split('/')[0];
  if (firstSegment === '.noemaloom') {
    return undefined;
  }
  return normalized;
}

function normalizeBudgets(value: unknown): WorksetBudgets {
  const raw = value && typeof value === 'object' ? value as Partial<WorksetBudgets> : {};
  return {
    activeMax: finiteNumber(raw.activeMax, DEFAULT_BUDGETS.activeMax),
    activeHardMax: finiteNumber(raw.activeHardMax, DEFAULT_BUDGETS.activeHardMax),
    pinnedMax: finiteNumber(raw.pinnedMax, DEFAULT_BUDGETS.pinnedMax),
    pinnedHardMax: finiteNumber(raw.pinnedHardMax, DEFAULT_BUDGETS.pinnedHardMax),
    perPathMax: finiteNumber(raw.perPathMax, DEFAULT_BUDGETS.perPathMax),
    perPathHardMax: finiteNumber(raw.perPathHardMax, DEFAULT_BUDGETS.perPathHardMax),
    coldArchiveMax: finiteNumber(raw.coldArchiveMax, DEFAULT_BUDGETS.coldArchiveMax),
    coldArchiveHardMax: finiteNumber(raw.coldArchiveHardMax, DEFAULT_BUDGETS.coldArchiveHardMax),
    injectionDefaultAnchors: finiteNumber(raw.injectionDefaultAnchors, DEFAULT_BUDGETS.injectionDefaultAnchors),
    injectionDefaultChars: finiteNumber(raw.injectionDefaultChars, DEFAULT_BUDGETS.injectionDefaultChars),
    injectionMinimalAnchors: finiteNumber(raw.injectionMinimalAnchors, DEFAULT_BUDGETS.injectionMinimalAnchors),
    injectionMinimalChars: finiteNumber(raw.injectionMinimalChars, DEFAULT_BUDGETS.injectionMinimalChars),
    injectionMultisurfaceAnchors: finiteNumber(raw.injectionMultisurfaceAnchors, DEFAULT_BUDGETS.injectionMultisurfaceAnchors),
    injectionMultisurfaceChars: finiteNumber(raw.injectionMultisurfaceChars, DEFAULT_BUDGETS.injectionMultisurfaceChars),
    injectionDebugAnchors: finiteNumber(raw.injectionDebugAnchors, DEFAULT_BUDGETS.injectionDebugAnchors),
    injectionDebugChars: finiteNumber(raw.injectionDebugChars, DEFAULT_BUDGETS.injectionDebugChars)
  };
}

function normalizeCounters(value: unknown): WorksetCounters {
  const raw = value && typeof value === 'object' ? value as Partial<WorksetCounters> : {};
  return {
    projectActivitySeq: finiteNumber(raw.projectActivitySeq, 0),
    navigationQuerySeq: finiteNumber(raw.navigationQuerySeq, 0),
    anchorInjectionSeq: finiteNumber(raw.anchorInjectionSeq, 0),
    readWriteSeq: finiteNumber(raw.readWriteSeq, 0)
  };
}

function normalizeOptions(value: unknown): WorksetOptions {
  const raw = value && typeof value === 'object' ? value as { navigation?: unknown } : {};
  const navigation = raw.navigation && typeof raw.navigation === 'object'
    ? raw.navigation as { enabled?: unknown; mode?: unknown }
    : {};
  return {
    navigation: {
      enabled: navigation.enabled === true,
      mode: navigation.mode === 'inject' ? 'inject' : 'silent'
    }
  };
}

function normalizeAnchor(value: unknown, counters: WorksetCounters, at: string): NavigationAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<NavigationAnchor>;
  if (typeof raw.path !== 'string' || raw.path.length === 0) return undefined;
  const anchorPath = normalizeNavigationAnchorPath(raw.path);
  if (!anchorPath) return undefined;
  const startLine = finiteNumber(raw.startLine, Number.NaN);
  const endLine = finiteNumber(raw.endLine, Number.NaN);
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : anchorIdFor({ ...raw, path: anchorPath }),
    path: anchorPath,
    label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : anchorPath,
    kind: typeof raw.kind === 'string' && raw.kind.length > 0 ? raw.kind : 'file',
    role: typeof raw.role === 'string' && raw.role.length > 0 ? raw.role : 'source_file',
    startLine: Number.isFinite(startLine) ? startLine : undefined,
    endLine: Number.isFinite(endLine) ? endLine : undefined,
    headingPath: stringArray(raw.headingPath),
    state: normalizeState(raw.state),
    pinned: raw.pinned === true,
    source: raw.source === 'agent_curated' || raw.source === 'checkpoint' || raw.source === 'imported' ? raw.source : 'nl_prepare_context',
    reason: typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : 'navigation target',
    score: finiteNumber(raw.score, 0),
    confidence: finiteNumber(raw.confidence, 0),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : at,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : at,
    createdSeq: finiteNumber(raw.createdSeq, counters.projectActivitySeq),
    lastSeenSeq: finiteNumber(raw.lastSeenSeq, counters.projectActivitySeq),
    lastInjectedSeq: typeof raw.lastInjectedSeq === 'number' ? raw.lastInjectedSeq : undefined,
    lastUsefulSeq: typeof raw.lastUsefulSeq === 'number' ? raw.lastUsefulSeq : undefined,
    ignoredInjectionCount: finiteNumber(raw.ignoredInjectionCount, 0),
    usefulHitCount: finiteNumber(raw.usefulHitCount, 0),
    tombstoneReason: typeof raw.tombstoneReason === 'string' ? raw.tombstoneReason : undefined
  };
}

function normalizeManifest(projectRoot: string, value: unknown, at = nowIso()): WorksetManifest {
  const raw = value && typeof value === 'object' ? value as Partial<WorksetManifest> : {};
  const counters = normalizeCounters(raw.counters);
  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.map(anchor => normalizeAnchor(anchor, counters, at)).filter((anchor): anchor is NavigationAnchor => Boolean(anchor))
    : [];
  const tombstoneInput = Array.isArray((raw as { tombstones?: unknown }).tombstones)
    ? (raw as { tombstones: unknown[] }).tombstones
    : [];
  const tombstones = tombstoneInput
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' && typeof (entry as { path?: unknown }).path === 'string')
    .map(entry => ({
      id: entry.id as string,
      path: entry.path as string,
      reason: typeof entry.reason === 'string' ? entry.reason : 'retired',
      tombstonedAt: typeof entry.tombstonedAt === 'string' ? entry.tombstonedAt : at,
      tombstonedSeq: finiteNumber(entry.tombstonedSeq, counters.projectActivitySeq)
    }));
  return {
    version: 1,
    projectRootHash: projectRootHash(projectRoot),
    counters,
    budgets: normalizeBudgets(raw.budgets),
    options: normalizeOptions(raw.options),
    anchors: sortAndCapAnchors(anchors, normalizeBudgets(raw.budgets)),
    tombstones
  };
}

export function createEmptyWorksetManifest(projectRoot: string): WorksetManifest {
  return {
    version: 1,
    projectRootHash: projectRootHash(projectRoot),
    counters: { ...DEFAULT_COUNTERS },
    budgets: { ...DEFAULT_BUDGETS },
    options: { navigation: { ...DEFAULT_OPTIONS.navigation } },
    anchors: [],
    tombstones: []
  };
}

async function readWorksetManifestUnlocked(projectRoot: string): Promise<WorksetManifest> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  try {
    return normalizeManifest(projectRoot, JSON.parse(await readFile(path.join(paths.worksetDir, 'anchors.json'), 'utf8')) as unknown);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return createEmptyWorksetManifest(projectRoot);
    }
    throw error;
  }
}

async function writeWorksetManifestUnlocked(projectRoot: string, manifest: WorksetManifest): Promise<WorksetManifest> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const normalized = normalizeManifest(paths.projectRoot, manifest);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.worksetDir, 'anchors.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export async function readWorksetManifest(projectRoot: string): Promise<WorksetManifest> {
  return readWorksetManifestUnlocked(projectRoot);
}

export async function writeWorksetManifest(projectRoot: string, manifest: WorksetManifest): Promise<void> {
  await withWorksetLock(projectRoot, async () => {
    await writeWorksetManifestUnlocked(projectRoot, manifest);
  });
}

export async function updateWorksetManifest<T>(
  projectRoot: string,
  update: (current: WorksetManifest) => Promise<{ manifest: WorksetManifest; result: T; write?: boolean }> | { manifest: WorksetManifest; result: T; write?: boolean }
): Promise<{ manifest: WorksetManifest; result: T }> {
  return withWorksetLock(projectRoot, async () => {
    const current = await readWorksetManifestUnlocked(projectRoot);
    const updated = await update(current);
    const manifest = updated.write === false ? normalizeManifest(projectRoot, updated.manifest) : await writeWorksetManifestUnlocked(projectRoot, updated.manifest);
    return { manifest, result: updated.result };
  });
}

export async function appendWorksetEvent(projectRoot: string, event: Record<string, unknown>): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  await appendFileInsideStateDir(paths.projectRoot, path.join(paths.worksetDir, 'events.jsonl'), `${JSON.stringify({ ...event, at: nowIso() })}\n`);
}

function rankAnchor(anchor: NavigationAnchor): number {
  const stateWeight = anchor.state === 'active' ? 1000 : anchor.state === 'dormant' ? 100 : anchor.state === 'archived' ? 10 : -1000;
  const pinnedWeight = anchor.pinned ? 500 : 0;
  return stateWeight + pinnedWeight + anchor.score + anchor.usefulHitCount * 10 - anchor.ignoredInjectionCount * 5 + anchor.lastSeenSeq / 1000;
}

export function sortAndCapAnchors(anchors: NavigationAnchor[], budgets: WorksetBudgets): NavigationAnchor[] {
  const byId = new Map<string, NavigationAnchor>();
  for (const anchor of anchors) {
    if (anchor.state === 'tombstoned') continue;
    const existing = byId.get(anchor.id);
    if (!existing || rankAnchor(anchor) >= rankAnchor(existing)) {
      byId.set(anchor.id, anchor);
    }
  }

  const sorted = [...byId.values()].sort((left, right) => rankAnchor(right) - rankAnchor(left) || left.path.localeCompare(right.path));
  const totalPerPath = new Map<string, number>();
  const activePerPath = new Map<string, number>();
  let activeCount = 0;
  let pinnedCount = 0;
  let coldCount = 0;
  const kept: NavigationAnchor[] = [];

  for (const anchor of sorted) {
    const totalCount = totalPerPath.get(anchor.path) ?? 0;
    if (totalCount >= budgets.perPathHardMax) continue;
    totalPerPath.set(anchor.path, totalCount + 1);

    let next = anchor;
    if (next.state === 'active') {
      const activePathCount = activePerPath.get(next.path) ?? 0;
      if (activeCount >= budgets.activeHardMax || activePathCount >= budgets.perPathMax) {
        next = { ...next, state: 'dormant' };
      } else {
        activeCount += 1;
        activePerPath.set(next.path, activePathCount + 1);
      }
    }

    if (next.pinned) {
      if (pinnedCount >= budgets.pinnedHardMax) {
        next = { ...next, pinned: false };
      } else {
        pinnedCount += 1;
      }
    }

    if (next.state !== 'active') {
      if (!next.pinned && coldCount >= budgets.coldArchiveHardMax) continue;
      coldCount += 1;
    }

    kept.push(next);
  }

  return kept.sort((left, right) => rankAnchor(right) - rankAnchor(left) || left.path.localeCompare(right.path));
}

function targetToAnchor(
  target: NavigationTargetLike,
  existing: NavigationAnchor | undefined,
  counters: WorksetCounters,
  at: string,
  source: NavigationAnchor['source'],
  reason: string,
  options: { defaultState?: Extract<NavigationAnchorLifecycleState, 'active' | 'dormant'>; reviveDormant?: boolean; preserveCurated?: boolean } = {}
): NavigationAnchor | undefined {
  if (typeof target.path !== 'string' || target.path.length === 0) return undefined;
  const anchorPath = normalizeNavigationAnchorPath(target.path);
  if (!anchorPath) return undefined;
  const normalizedTarget = { ...target, path: anchorPath };
  const id = anchorIdFor(normalizedTarget);
  if (existing?.state === 'tombstoned' || existing?.state === 'retired') {
    return existing;
  }

  const isAutomaticObservation = source === 'nl_prepare_context';
  const preservedExisting = options.preserveCurated !== false &&
    isAutomaticObservation &&
    existing &&
    existing.source !== 'nl_prepare_context'
    ? existing
    : undefined;
  const nextState = (() => {
    if (!existing) return options.defaultState ?? 'active';
    if (preservedExisting) return preservedExisting.state;
    if (isAutomaticObservation && options.reviveDormant === false && (existing.state === 'archived' || existing.state === 'dormant')) {
      return existing.state;
    }
    if (source === 'agent_curated') return 'active';
    return existing.state === 'archived' || existing.state === 'dormant' ? 'active' : existing.state;
  })();
  const nextSource = preservedExisting ? preservedExisting.source : source;
  const nextReason = preservedExisting
    ? preservedExisting.reason
    : (typeof target.reason === 'string' && target.reason.length > 0 ? target.reason : reason);

  return {
    id,
    path: anchorPath,
    label: preservedExisting ? preservedExisting.label : (typeof target.label === 'string' && target.label.length > 0 ? target.label : anchorPath),
    kind: typeof target.kind === 'string' && target.kind.length > 0 ? target.kind : existing?.kind ?? 'file',
    role: typeof target.role === 'string' && target.role.length > 0 ? target.role : existing?.role ?? 'source_file',
    startLine: typeof target.startLine === 'number' ? target.startLine : existing?.startLine,
    endLine: typeof target.endLine === 'number' ? target.endLine : existing?.endLine,
    headingPath: stringArray(target.headingPath).length > 0 ? stringArray(target.headingPath) : existing?.headingPath ?? [],
    state: nextState,
    pinned: preservedExisting ? preservedExisting.pinned : existing?.pinned ?? false,
    source: nextSource,
    reason: nextReason,
    score: Math.max(finiteNumber(target.score, existing?.score ?? 0), existing?.score ?? Number.NEGATIVE_INFINITY),
    confidence: Math.max(finiteNumber(target.confidence, existing?.confidence ?? 0), existing?.confidence ?? Number.NEGATIVE_INFINITY),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    createdSeq: existing?.createdSeq ?? counters.projectActivitySeq,
    lastSeenSeq: counters.projectActivitySeq,
    lastInjectedSeq: existing?.lastInjectedSeq,
    lastUsefulSeq: existing?.lastUsefulSeq,
    ignoredInjectionCount: existing?.ignoredInjectionCount ?? 0,
    usefulHitCount: existing?.usefulHitCount ?? 0,
    tombstoneReason: existing?.tombstoneReason
  };
}

export function upsertNavigationTargets(input: {
  manifest: WorksetManifest;
  targets: NavigationTargetLike[];
  source?: NavigationAnchor['source'];
  reason?: string;
  now?: Date;
  maxTargets?: number;
  defaultState?: Extract<NavigationAnchorLifecycleState, 'active' | 'dormant'>;
  reviveDormant?: boolean;
  preserveCurated?: boolean;
}): WorksetManifest {
  const at = nowIso(input.now);
  const manifest: WorksetManifest = {
    ...input.manifest,
    counters: {
      ...input.manifest.counters,
      projectActivitySeq: input.manifest.counters.projectActivitySeq + 1,
      navigationQuerySeq: input.manifest.counters.navigationQuerySeq + 1
    }
  };
  const byId = new Map(manifest.anchors.map(anchor => [anchor.id, anchor]));
  const tombstoneIds = new Set(manifest.tombstones.map(entry => entry.id));
  const tombstonePaths = new Set(manifest.tombstones.map(entry => entry.path));
  for (const target of input.targets.slice(0, input.maxTargets ?? manifest.budgets.injectionDebugAnchors)) {
    const anchorPath = typeof target.path === 'string' ? normalizeNavigationAnchorPath(target.path) : undefined;
    if (!anchorPath) {
      continue;
    }
    const normalizedTarget = { ...target, path: anchorPath };
    const id = anchorIdFor(normalizedTarget);
    if (tombstoneIds.has(id) || tombstonePaths.has(anchorPath)) {
      continue;
    }
    const anchor = targetToAnchor(
      normalizedTarget,
      byId.get(id),
      manifest.counters,
      at,
      input.source ?? 'nl_prepare_context',
      input.reason ?? 'nl_prepare_context target',
      {
        defaultState: input.defaultState,
        reviveDormant: input.reviveDormant,
        preserveCurated: input.preserveCurated
      }
    );
    if (anchor) byId.set(anchor.id, anchor);
  }
  return {
    ...manifest,
    anchors: sortAndCapAnchors([...byId.values()], manifest.budgets)
  };
}

export async function recordNavigationTargets(input: {
  projectRoot: string;
  targets: NavigationTargetLike[];
  source?: NavigationAnchor['source'];
  reason?: string;
  now?: Date;
  maxTargets?: number;
  defaultState?: Extract<NavigationAnchorLifecycleState, 'active' | 'dormant'>;
  reviveDormant?: boolean;
  preserveCurated?: boolean;
}): Promise<WorksetManifest> {
  const { manifest: next } = await updateWorksetManifest(input.projectRoot, current => {
    const nextManifest = upsertNavigationTargets({
      manifest: current,
      targets: input.targets,
      source: input.source,
      reason: input.reason,
      now: input.now,
      maxTargets: input.maxTargets,
      defaultState: input.defaultState,
      reviveDormant: input.reviveDormant,
      preserveCurated: input.preserveCurated
    });
    return { manifest: nextManifest, result: nextManifest };
  });
  await appendWorksetEvent(input.projectRoot, {
    type: 'navigation_query',
    navigationQuerySeq: next.counters.navigationQuerySeq,
    projectActivitySeq: next.counters.projectActivitySeq,
    targetCount: input.targets.length
  });
  return next;
}

export function setNavigationEnabled(manifest: WorksetManifest, enabled: boolean, mode: WorksetOptions['navigation']['mode'] = enabled ? 'inject' : 'silent'): WorksetManifest {
  return {
    ...manifest,
    options: {
      ...manifest.options,
      navigation: { enabled, mode }
    }
  };
}

export function selectNavigationAnchors(manifest: WorksetManifest, options: RenderNavigationOptions = {}): NavigationAnchor[] {
  if (!manifest.options.navigation.enabled && !options.includeDisabled) return [];
  const profile = options.profile ?? 'default';
  const maxAnchors = options.maxAnchors ?? (
    profile === 'minimal' ? manifest.budgets.injectionMinimalAnchors
      : profile === 'multisurface' ? manifest.budgets.injectionMultisurfaceAnchors
        : profile === 'debug' ? manifest.budgets.injectionDebugAnchors
          : manifest.budgets.injectionDefaultAnchors
  );
  return manifest.anchors
    .filter(anchor => anchor.state === 'active' || (options.includeDormant === true && anchor.state === 'dormant'))
    .sort((left, right) => rankAnchor(right) - rankAnchor(left) || left.path.localeCompare(right.path))
    .slice(0, maxAnchors);
}

function cardForAnchor(anchor: NavigationAnchor): NavigationCard {
  const hasLines = typeof anchor.startLine === 'number' && typeof anchor.endLine === 'number';
  return {
    id: anchor.id,
    path: anchor.path,
    label: anchor.label,
    kind: anchor.kind,
    role: anchor.role,
    lines: hasLines ? `${anchor.startLine}-${anchor.endLine}` : undefined,
    reason: anchor.reason,
    state: anchor.state,
    pinned: anchor.pinned
  };
}

function cardLine(card: NavigationCard): string {
  const linePart = card.lines ? `:${card.lines}` : '';
  const pin = card.pinned ? ' pinned' : '';
  return `- ${card.path}${linePart} [${card.kind}/${card.role}${pin}] ${card.label} — ${card.reason}`;
}

export function renderNavigationCards(manifest: WorksetManifest, options: RenderNavigationOptions = {}): { cards: NavigationCard[]; text: string; charBudget: number; truncated: boolean } {
  const profile = options.profile ?? 'default';
  const charBudget = options.charBudget ?? (
    profile === 'minimal' ? manifest.budgets.injectionMinimalChars
      : profile === 'multisurface' ? manifest.budgets.injectionMultisurfaceChars
        : profile === 'debug' ? manifest.budgets.injectionDebugChars
          : manifest.budgets.injectionDefaultChars
  );
  const cards = selectNavigationAnchors(manifest, options).map(cardForAnchor);
  const lines: string[] = [];
  let truncated = false;
  for (const card of cards) {
    const next = cardLine(card);
    const candidate = [...lines, next].join('\n');
    if (candidate.length > charBudget) {
      truncated = true;
      break;
    }
    lines.push(next);
  }
  const text = lines.length > 0 ? ['NoemaLoom navigation anchors:', ...lines].join('\n') : '';
  return { cards: cards.slice(0, lines.length), text, charBudget, truncated };
}

export function markAnchorsInjected(manifest: WorksetManifest, anchorIds: string[], now?: Date): WorksetManifest {
  const at = nowIso(now);
  const nextCounters = {
    ...manifest.counters,
    projectActivitySeq: manifest.counters.projectActivitySeq + 1,
    anchorInjectionSeq: manifest.counters.anchorInjectionSeq + 1
  };
  const idSet = new Set(anchorIds);
  return {
    ...manifest,
    counters: nextCounters,
    anchors: manifest.anchors.map(anchor => idSet.has(anchor.id)
      ? {
          ...anchor,
          updatedAt: at,
          lastInjectedSeq: nextCounters.anchorInjectionSeq,
          ignoredInjectionCount: anchor.ignoredInjectionCount + 1,
          state: anchor.ignoredInjectionCount + 1 >= 2 && anchor.usefulHitCount === 0 && !anchor.pinned ? 'dormant' : anchor.state
        }
      : anchor)
  };
}

export function markAnchorUseful(manifest: WorksetManifest, matcher: { id?: string; path?: string }, now?: Date): WorksetManifest {
  const at = nowIso(now);
  const nextCounters = {
    ...manifest.counters,
    projectActivitySeq: manifest.counters.projectActivitySeq + 1,
    readWriteSeq: manifest.counters.readWriteSeq + 1
  };
  return {
    ...manifest,
    counters: nextCounters,
    anchors: manifest.anchors.map(anchor => (matcher.id && anchor.id === matcher.id) || (matcher.path && anchor.path === matcher.path)
      ? {
          ...anchor,
          updatedAt: at,
          lastUsefulSeq: nextCounters.readWriteSeq,
          usefulHitCount: anchor.usefulHitCount + 1,
          ignoredInjectionCount: 0,
          state: anchor.state === 'archived' || anchor.state === 'dormant' ? 'active' : anchor.state
        }
      : anchor)
  };
}

export function retireAnchor(manifest: WorksetManifest, anchorId: string, reason: string, now?: Date): WorksetManifest {
  const at = nowIso(now);
  const nextCounters = {
    ...manifest.counters,
    projectActivitySeq: manifest.counters.projectActivitySeq + 1
  };
  const retired = manifest.anchors.find(anchor => anchor.id === anchorId);
  const anchors = manifest.anchors.filter(anchor => anchor.id !== anchorId);
  const tombstoneExists = manifest.tombstones.some(entry => entry.id === anchorId);
  return {
    ...manifest,
    counters: nextCounters,
    anchors,
    tombstones: retired && !tombstoneExists
      ? [...manifest.tombstones, { id: retired.id, path: retired.path, reason, tombstonedAt: at, tombstonedSeq: nextCounters.projectActivitySeq }]
      : manifest.tombstones
  };
}

export function updateAnchorState(manifest: WorksetManifest, anchorId: string, state: Exclude<NavigationAnchorLifecycleState, 'tombstoned'>, reason: string, now?: Date): WorksetManifest {
  const at = nowIso(now);
  const nextCounters = {
    ...manifest.counters,
    projectActivitySeq: manifest.counters.projectActivitySeq + 1
  };
  return {
    ...manifest,
    counters: nextCounters,
    anchors: manifest.anchors.map(anchor => anchor.id === anchorId && anchor.state !== 'tombstoned'
      ? { ...anchor, state, reason, source: 'agent_curated' as const, updatedAt: at, lastSeenSeq: nextCounters.projectActivitySeq }
      : anchor)
  };
}

export function worksetRevision(manifest: WorksetManifest): string {
  return `workset-${sha1(JSON.stringify({ anchors: manifest.anchors.map(anchor => [anchor.id, anchor.path, anchor.state, anchor.pinned, anchor.updatedAt]), counters: manifest.counters, enabled: manifest.options.navigation.enabled })).slice(0, 16)}`;
}
