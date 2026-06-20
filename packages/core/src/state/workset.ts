import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileInsideStateDir, appendFileInsideStateDir } from '../safety/path-guard.js';
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

function anchorIdFor(target: Pick<NavigationTargetLike, 'spanId' | 'path' | 'startLine' | 'endLine' | 'label' | 'kind'>): string {
  const stable = target.spanId || `${target.path ?? 'unknown'}:${target.startLine ?? ''}:${target.endLine ?? ''}:${target.kind ?? ''}:${target.label ?? ''}`;
  return `nav-${sha1(stable).slice(0, 16)}`;
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
  const startLine = finiteNumber(raw.startLine, Number.NaN);
  const endLine = finiteNumber(raw.endLine, Number.NaN);
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : anchorIdFor(raw),
    path: raw.path,
    label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : raw.path,
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

export async function readWorksetManifest(projectRoot: string): Promise<WorksetManifest> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  try {
    return normalizeManifest(projectRoot, JSON.parse(await readFile(path.join(paths.worksetDir, 'anchors.json'), 'utf8')) as unknown);
  } catch {
    return createEmptyWorksetManifest(projectRoot);
  }
}

export async function writeWorksetManifest(projectRoot: string, manifest: WorksetManifest): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  const normalized = normalizeManifest(paths.projectRoot, manifest);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.worksetDir, 'anchors.json'), `${JSON.stringify(normalized, null, 2)}\n`);
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
    const existing = byId.get(anchor.id);
    if (!existing || rankAnchor(anchor) >= rankAnchor(existing)) {
      byId.set(anchor.id, anchor);
    }
  }
  const sorted = [...byId.values()].sort((left, right) => rankAnchor(right) - rankAnchor(left) || left.path.localeCompare(right.path));
  const perPathCounts = new Map<string, number>();
  const active: NavigationAnchor[] = [];
  const pinned: NavigationAnchor[] = [];
  const cold: NavigationAnchor[] = [];
  for (const anchor of sorted) {
    const count = perPathCounts.get(anchor.path) ?? 0;
    if (count >= budgets.perPathHardMax) continue;
    perPathCounts.set(anchor.path, count + 1);
    if (anchor.pinned && pinned.length < budgets.pinnedHardMax) {
      pinned.push(anchor);
    } else if (anchor.state === 'active' && active.length < budgets.activeHardMax) {
      active.push(anchor);
    } else if (anchor.state !== 'tombstoned' && cold.length < budgets.coldArchiveHardMax) {
      cold.push(anchor.state === 'active' ? { ...anchor, state: 'dormant' } : anchor);
    }
  }
  return [...pinned, ...active, ...cold].sort((left, right) => rankAnchor(right) - rankAnchor(left) || left.path.localeCompare(right.path));
}

function targetToAnchor(target: NavigationTargetLike, existing: NavigationAnchor | undefined, counters: WorksetCounters, at: string, source: NavigationAnchor['source'], reason: string): NavigationAnchor | undefined {
  if (typeof target.path !== 'string' || target.path.length === 0) return undefined;
  const id = anchorIdFor(target);
  if (existing?.state === 'tombstoned' || existing?.state === 'retired') {
    return existing;
  }
  return {
    id,
    path: target.path,
    label: typeof target.label === 'string' && target.label.length > 0 ? target.label : target.path,
    kind: typeof target.kind === 'string' && target.kind.length > 0 ? target.kind : 'file',
    role: typeof target.role === 'string' && target.role.length > 0 ? target.role : 'source_file',
    startLine: typeof target.startLine === 'number' ? target.startLine : undefined,
    endLine: typeof target.endLine === 'number' ? target.endLine : undefined,
    headingPath: stringArray(target.headingPath),
    state: existing?.state === 'archived' || existing?.state === 'dormant' ? 'active' : existing?.state ?? 'active',
    pinned: existing?.pinned ?? false,
    source,
    reason: typeof target.reason === 'string' && target.reason.length > 0 ? target.reason : reason,
    score: finiteNumber(target.score, existing?.score ?? 0),
    confidence: finiteNumber(target.confidence, existing?.confidence ?? 0),
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
    const id = anchorIdFor(target);
    if (tombstoneIds.has(id) || (typeof target.path === 'string' && tombstonePaths.has(target.path))) {
      continue;
    }
    const anchor = targetToAnchor(target, byId.get(id), manifest.counters, at, input.source ?? 'nl_prepare_context', input.reason ?? 'nl_prepare_context target');
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
}): Promise<WorksetManifest> {
  const current = await readWorksetManifest(input.projectRoot);
  const next = upsertNavigationTargets({
    manifest: current,
    targets: input.targets,
    source: input.source,
    reason: input.reason,
    now: input.now,
    maxTargets: input.maxTargets
  });
  await writeWorksetManifest(input.projectRoot, next);
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
    .filter(anchor => ['active', 'dormant'].includes(anchor.state))
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
  const anchors = manifest.anchors.map(anchor => anchor.id === anchorId
    ? { ...anchor, state: 'tombstoned' as const, updatedAt: at, tombstoneReason: reason }
    : anchor);
  const retired = manifest.anchors.find(anchor => anchor.id === anchorId);
  return {
    ...manifest,
    counters: nextCounters,
    anchors,
    tombstones: retired
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
