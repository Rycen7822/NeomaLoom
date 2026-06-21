import path from 'node:path';

import type { RepoSpan } from './types.js';

export type RepoSymbolRecord = {
  symbolFqn: string;
  spanId: string;
  path: string;
  language: string;
  symbolName: string;
  symbolKind: string;
  parentSymbolFqn?: string;
  modulePath: string;
  signature: string;
  exported: boolean;
  deprecated: boolean;
  deprecatedMessage?: string;
  supersededBy?: string;
  metadata: Record<string, unknown>;
};

export type RepoSymbolAliasRecord = {
  aliasFqn: string;
  targetFqn: string;
  aliasKind: string;
  path: string;
  line: number;
  metadata: Record<string, unknown>;
};

export type RetrievalCoreRecords = {
  symbols: RepoSymbolRecord[];
  aliases: RepoSymbolAliasRecord[];
};

type ImportAliasMetadata = {
  importedName: string;
  localName: string;
  source?: string;
  resolvedSource?: string;
  aliasKind?: string;
};

function isCodeSymbol(span: RepoSpan): boolean {
  return span.kind.startsWith('code.') && !['code.module', 'code.import', 'code.callsite'].includes(span.kind);
}

function symbolFqn(span: RepoSpan): string {
  return String(span.metadata.qualifiedName ?? `${span.path}:${span.label}`);
}

function modulePathFor(span: RepoSpan): string {
  const parsed = path.posix.parse(span.path);
  return path.posix.join(parsed.dir, parsed.name).replace(/^\.\//, '');
}

function deprecatedState(span: RepoSpan): { deprecated: boolean; deprecatedMessage?: string; supersededBy?: string } {
  const message = typeof span.metadata.deprecatedMessage === 'string' ? span.metadata.deprecatedMessage : undefined;
  const supersededBy = typeof span.metadata.supersededBy === 'string' ? span.metadata.supersededBy : undefined;
  const deprecated = span.metadata.deprecated === true || /@deprecated\b/i.test(span.indexedText) || Boolean(message || supersededBy);
  return { deprecated, deprecatedMessage: message, supersededBy };
}

function parentSymbolFqn(span: RepoSpan): string | undefined {
  if (typeof span.metadata.parentSymbolFqn === 'string') return span.metadata.parentSymbolFqn;
  if (typeof span.metadata.className === 'string') return `${span.path}:${span.metadata.className}`;
  const fqn = symbolFqn(span);
  const lastDot = fqn.lastIndexOf('.');
  const pathPrefix = `${span.path}:`;
  if (lastDot > pathPrefix.length) return fqn.slice(0, lastDot);
  return undefined;
}

function aliasesFromMetadata(span: RepoSpan): ImportAliasMetadata[] {
  const rawAliases = span.metadata.aliases;
  if (Array.isArray(rawAliases)) {
    return rawAliases
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        importedName: String(item.importedName ?? ''),
        localName: String(item.localName ?? item.importedName ?? ''),
        source: typeof item.source === 'string' ? item.source : undefined,
        resolvedSource: typeof item.resolvedSource === 'string' ? item.resolvedSource : undefined,
        aliasKind: typeof item.aliasKind === 'string' ? item.aliasKind : 'named'
      }))
      .filter(alias => alias.importedName.length > 0 && alias.localName.length > 0);
  }
  const importedNames = Array.isArray(span.metadata.importedNames) ? span.metadata.importedNames.map(String).filter(Boolean) : [];
  return importedNames.map(importedName => ({
    importedName,
    localName: importedName,
    source: typeof span.metadata.source === 'string' ? span.metadata.source : undefined,
    resolvedSource: typeof span.metadata.resolvedSource === 'string' ? span.metadata.resolvedSource : undefined,
    aliasKind: 'named'
  }));
}

function sourceVariants(source: string | undefined): string[] {
  if (!source) return [];
  const normalized = source.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/index$/, '');
  const variants = new Set<string>([normalized]);
  if (!/\.[A-Za-z0-9]+$/.test(normalized)) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']) {
      variants.add(`${normalized}${ext}`);
      variants.add(`${normalized}/index${ext}`);
    }
  }
  return [...variants];
}

function resolveAliasTarget(alias: ImportAliasMetadata, symbolsByFqn: Map<string, RepoSymbolRecord>, symbolsByPathAndName: Map<string, RepoSymbolRecord>): RepoSymbolRecord | undefined {
  for (const source of sourceVariants(alias.resolvedSource ?? alias.source)) {
    const fqn = `${source}:${alias.importedName}`;
    const direct = symbolsByFqn.get(fqn);
    if (direct) return direct;
    const byPath = symbolsByPathAndName.get(`${source}:${alias.importedName}`);
    if (byPath) return byPath;
  }
  return undefined;
}

function bySpanOrder(left: RepoSpan, right: RepoSpan): number {
  return left.path.localeCompare(right.path) || left.startLine - right.startLine || left.endLine - right.endLine || left.spanId.localeCompare(right.spanId);
}

function duplicateAwareMetadata(span: RepoSpan, baseFqn: string, overloadOrdinal: number, overloadCount: number): Record<string, unknown> {
  if (overloadCount <= 1) {
    return span.metadata;
  }
  return {
    ...span.metadata,
    baseSymbolFqn: baseFqn,
    overloadOrdinal,
    overloadCount
  };
}

function duplicateAwareSymbolFqn(baseFqn: string, overloadOrdinal: number, overloadCount: number): string {
  if (overloadCount <= 1 || overloadOrdinal === 1) {
    return baseFqn;
  }
  return `${baseFqn}#overload${overloadOrdinal}`;
}

function firstValueMap<K, V>(entries: Array<[K, V]>): Map<K, V> {
  const map = new Map<K, V>();
  for (const [key, value] of entries) {
    if (!map.has(key)) {
      map.set(key, value);
    }
  }
  return map;
}

export function buildRetrievalCoreRecords(spans: RepoSpan[]): RetrievalCoreRecords {
  const codeSymbols = spans.filter(isCodeSymbol).sort(bySpanOrder);
  const duplicateCounts = new Map<string, number>();
  for (const span of codeSymbols) {
    const baseFqn = symbolFqn(span);
    duplicateCounts.set(baseFqn, (duplicateCounts.get(baseFqn) ?? 0) + 1);
  }

  const seenByBaseFqn = new Map<string, number>();
  const symbols: RepoSymbolRecord[] = codeSymbols
    .map(span => {
      const baseFqn = symbolFqn(span);
      const overloadCount = duplicateCounts.get(baseFqn) ?? 1;
      const overloadOrdinal = (seenByBaseFqn.get(baseFqn) ?? 0) + 1;
      seenByBaseFqn.set(baseFqn, overloadOrdinal);
      const deprecated = deprecatedState(span);
      return {
        symbolFqn: duplicateAwareSymbolFqn(baseFqn, overloadOrdinal, overloadCount),
        spanId: span.spanId,
        path: span.path,
        language: span.language,
        symbolName: span.label,
        symbolKind: span.kind,
        parentSymbolFqn: parentSymbolFqn(span),
        modulePath: modulePathFor(span),
        signature: String(span.metadata.signature ?? span.label),
        exported: span.metadata.exported === true || /^\s*export\b/.test(span.indexedText),
        ...deprecated,
        metadata: duplicateAwareMetadata(span, baseFqn, overloadOrdinal, overloadCount)
      };
    })
    .sort((left, right) => left.symbolFqn.localeCompare(right.symbolFqn) || left.spanId.localeCompare(right.spanId));

  const symbolsByFqn = new Map(symbols.map(symbol => [symbol.symbolFqn, symbol]));
  const symbolsByPathAndName = firstValueMap(symbols.map(symbol => [`${symbol.path}:${symbol.symbolName}`, symbol]));
  const aliasesByFqn = new Map<string, RepoSymbolAliasRecord>();

  for (const span of spans.filter(candidate => candidate.kind === 'code.import')) {
    for (const alias of aliasesFromMetadata(span)) {
      const target = resolveAliasTarget(alias, symbolsByFqn, symbolsByPathAndName);
      if (!target) continue;
      const aliasFqn = `${span.path}:${alias.localName}`;
      aliasesByFqn.set(aliasFqn, {
        aliasFqn,
        targetFqn: target.symbolFqn,
        aliasKind: alias.aliasKind ?? 'named',
        path: span.path,
        line: span.startLine,
        metadata: {
          importedName: alias.importedName,
          localName: alias.localName,
          source: alias.source,
          resolvedSource: alias.resolvedSource
        }
      });
    }
  }

  return {
    symbols,
    aliases: [...aliasesByFqn.values()].sort((left, right) => left.aliasFqn.localeCompare(right.aliasFqn))
  };
}
