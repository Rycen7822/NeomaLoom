import { createHash } from 'node:crypto';

import type { CodeFactEdge, CodeFactSpan } from './extractor.js';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function edgeId(input: {
  sourceSpanId: string;
  targetSpanId: string;
  relation: string;
}): string {
  return `edge:${sha1(`${input.sourceSpanId}:${input.relation}:${input.targetSpanId}`)}`;
}

function createEdge(input: Omit<CodeFactEdge, 'edgeId'>): CodeFactEdge {
  return {
    ...input,
    edgeId: edgeId(input)
  };
}

type ImportAlias = {
  importedName: string;
  localName: string;
  source?: string;
  resolvedSource?: string;
};

function qualifiedName(span: CodeFactSpan): string {
  return String(span.metadata.qualifiedName ?? `${span.path}:${span.label}`);
}

function isSymbolSpan(span: CodeFactSpan): boolean {
  return !['code.module', 'code.import', 'code.callsite'].includes(span.kind);
}

function aliasRecords(span: CodeFactSpan): ImportAlias[] {
  const aliases = span.metadata.aliases;
  if (Array.isArray(aliases)) {
    return aliases
      .filter((alias): alias is Record<string, unknown> => typeof alias === 'object' && alias !== null)
      .map(alias => ({
        importedName: String(alias.importedName ?? ''),
        localName: String(alias.localName ?? alias.importedName ?? ''),
        source: typeof alias.source === 'string' ? alias.source : undefined,
        resolvedSource: typeof alias.resolvedSource === 'string' ? alias.resolvedSource : undefined
      }))
      .filter(alias => alias.importedName.length > 0 && alias.localName.length > 0);
  }
  const importedNames = Array.isArray(span.metadata.importedNames) ? span.metadata.importedNames : [];
  return importedNames
    .map(importedName => String(importedName))
    .filter(Boolean)
    .map(importedName => ({
      importedName,
      localName: importedName,
      source: typeof span.metadata.source === 'string' ? span.metadata.source : undefined,
      resolvedSource: typeof span.metadata.resolvedSource === 'string' ? span.metadata.resolvedSource : undefined
    }));
}

function sourcePathVariants(source: string | undefined): string[] {
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

function findSymbolByFqnOrSource(input: {
  byFqn: Map<string, CodeFactSpan>;
  byPathAndLabel: Map<string, CodeFactSpan>;
  alias: ImportAlias;
}): CodeFactSpan | undefined {
  for (const source of sourcePathVariants(input.alias.resolvedSource ?? input.alias.source)) {
    const fqn = `${source}:${input.alias.importedName}`;
    const exact = input.byFqn.get(fqn);
    if (exact) return exact;
    const byPath = input.byPathAndLabel.get(`${source}:${input.alias.importedName}`);
    if (byPath) return byPath;
  }
  return undefined;
}

function findLocalCaller(input: {
  byFqn: Map<string, CodeFactSpan>;
  byPathAndLabel: Map<string, CodeFactSpan>;
  byLabel: Map<string, CodeFactSpan[]>;
  path: string;
  callerLabel?: string;
}): CodeFactSpan | undefined {
  if (!input.callerLabel) return undefined;
  const exactFqn = input.byFqn.get(`${input.path}:${input.callerLabel}`);
  if (exactFqn) return exactFqn;
  const localLabel = input.callerLabel.split('.').at(-1) ?? input.callerLabel;
  return input.byPathAndLabel.get(`${input.path}:${localLabel}`) ?? input.byLabel.get(localLabel)?.[0];
}

export function resolveCodeFactEdges(spans: CodeFactSpan[]): CodeFactEdge[] {
  const edges: CodeFactEdge[] = [];
  const modules = new Map<string, CodeFactSpan>();
  const symbolsByLabel = new Map<string, CodeFactSpan[]>();
  const symbolsByFqn = new Map<string, CodeFactSpan>();
  const symbolsByPathAndLabel = new Map<string, CodeFactSpan>();
  const aliasesByPathAndLocalName = new Map<string, CodeFactSpan>();

  for (const span of spans) {
    if (span.kind === 'code.module') {
      modules.set(span.path, span);
      continue;
    }
    if (isSymbolSpan(span)) {
      const existing = symbolsByLabel.get(span.label) ?? [];
      existing.push(span);
      symbolsByLabel.set(span.label, existing);
      symbolsByFqn.set(qualifiedName(span), span);
      symbolsByPathAndLabel.set(`${span.path}:${span.label}`, span);
    }
  }

  for (const importSpan of spans.filter(span => span.kind === 'code.import')) {
    for (const alias of aliasRecords(importSpan)) {
      const target = findSymbolByFqnOrSource({ byFqn: symbolsByFqn, byPathAndLabel: symbolsByPathAndLabel, alias }) ??
        symbolsByLabel.get(alias.importedName)?.[0];
      if (!target) continue;
      aliasesByPathAndLocalName.set(`${importSpan.path}:${alias.localName}`, target);
      edges.push(
        createEdge({
          sourceSpanId: importSpan.spanId,
          targetSpanId: target.spanId,
          relation: 'imports',
          sourceLabel: importSpan.label,
          targetLabel: target.label,
          confidence: 0.94,
          evidence: {
            importedName: alias.importedName,
            localName: alias.localName,
            source: alias.source,
            resolvedSource: alias.resolvedSource,
            resolvedBy: 'import_alias'
          }
        })
      );
    }
  }

  for (const span of spans) {
    const module = modules.get(span.path);
    if (module && span.kind !== 'code.module') {
      edges.push(
        createEdge({
          sourceSpanId: module.spanId,
          targetSpanId: span.spanId,
          relation: 'contains',
          sourceLabel: module.label,
          targetLabel: span.label,
          confidence: 1,
          evidence: {
            path: span.path
          }
        })
      );
    }

    if (span.kind === 'code.callsite') {
      const target = aliasesByPathAndLocalName.get(`${span.path}:${span.label}`) ?? symbolsByPathAndLabel.get(`${span.path}:${span.label}`) ?? symbolsByLabel.get(span.label)?.[0];
      const callerLabel = typeof span.metadata.callerLabel === 'string' ? span.metadata.callerLabel : undefined;
      const source = findLocalCaller({
        byFqn: symbolsByFqn,
        byPathAndLabel: symbolsByPathAndLabel,
        byLabel: symbolsByLabel,
        path: span.path,
        callerLabel
      });
      if (!target || !source) {
        continue;
      }
      const resolvedBy = aliasesByPathAndLocalName.has(`${span.path}:${span.label}`) ? 'import_alias' : 'label';
      edges.push(
        createEdge({
          sourceSpanId: source.spanId,
          targetSpanId: target.spanId,
          relation: 'calls',
          sourceLabel: source.label,
          targetLabel: target.label,
          confidence: resolvedBy === 'import_alias' ? 0.96 : 0.9,
          evidence: {
            callLine: span.startLine,
            resolvedBy
          }
        })
      );
    }
  }

  return edges;
}
