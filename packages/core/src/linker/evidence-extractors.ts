import type { EdgeRelation } from '../spans/enums.js';
import type { RepoSpan } from '../spans/types.js';
import type { EvidenceKind } from './confidence.js';
import type { LinkCandidate } from './cross-reference-linker.js';

export function createEvidenceCandidate(input: {
  sourceSpanId: string;
  targetSpanId: string;
  relation: EdgeRelation;
  evidenceKind: EvidenceKind;
  evidence?: Record<string, unknown>;
  confidence?: number;
}): LinkCandidate {
  return {
    sourceSpanId: input.sourceSpanId,
    targetSpanId: input.targetSpanId,
    relation: input.relation,
    evidenceKind: input.evidenceKind,
    evidence: input.evidence ?? {},
    confidence: input.confidence
  };
}

function metadataArray(span: RepoSpan, key: string): string[] {
  const value = span.metadata[key];
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function metadataString(span: RepoSpan, key: string): string | undefined {
  const value = span.metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function relativeTarget(sourcePath: string, targetPath: string): string {
  const base = normalizePath(sourcePath).split('/').slice(0, -1).join('/');
  const parts = `${base}/${targetPath}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function codeMatches(span: RepoSpan, mention: string): boolean {
  if (!span.kind.startsWith('code.')) return false;
  return span.label === mention || span.symbolPath.join('.') === mention || metadataString(span, 'qualifiedName') === mention;
}

function configMatches(span: RepoSpan, mention: string): boolean {
  if (!span.kind.startsWith('config.')) return false;
  return [span.label, metadataString(span, 'configKey'), metadataString(span, 'cliFlag'), metadataString(span, 'envVar'), metadataString(span, 'schemaFieldName')]
    .filter(Boolean)
    .includes(mention);
}

function textCalls(span: RepoSpan, label: string): boolean {
  return new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(span.indexedText);
}

function pushCandidate(candidates: LinkCandidate[], keys: Set<string>, candidate: LinkCandidate): void {
  const key = `${candidate.sourceSpanId}\0${candidate.targetSpanId}\0${candidate.relation}\0${candidate.evidenceKind}`;
  if (keys.has(key)) return;
  keys.add(key);
  candidates.push(candidate);
}

function linkedSpanIds(span: RepoSpan, key: string): string[] {
  return metadataArray(span, key).filter(Boolean);
}

function addToIndex(index: Map<string, RepoSpan[]>, key: string | undefined, span: RepoSpan): void {
  if (!key) return;
  const existing = index.get(key) ?? [];
  existing.push(span);
  index.set(key, existing);
}

function tokensMatching(input: string, pattern: RegExp): string[] {
  const tokens = new Set<string>();
  for (const match of input.matchAll(pattern)) {
    if (match[1]) tokens.add(match[1]);
  }
  return [...tokens];
}

function codeLookupKeys(span: RepoSpan): string[] {
  return [span.label, span.symbolPath.join('.'), metadataString(span, 'qualifiedName')].filter((item): item is string => Boolean(item));
}

function configLookupKeys(span: RepoSpan): string[] {
  return [span.label, metadataString(span, 'configKey'), metadataString(span, 'cliFlag'), metadataString(span, 'envVar'), metadataString(span, 'schemaFieldName')].filter(
    (item): item is string => Boolean(item)
  );
}

function linkTargetsForPath(spansForPath: RepoSpan[], anchor?: string): RepoSpan[] {
  if (anchor) {
    return spansForPath.filter(target => target.anchor === anchor && (target.kind === 'doc.heading' || target.kind === 'doc.section'));
  }
  const fileSpans = spansForPath.filter(target => target.kind === 'file');
  return fileSpans.length > 0 ? fileSpans : spansForPath.slice(0, 1);
}

export function extractLinkCandidatesFromSpans(spans: RepoSpan[]): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const candidateKeys = new Set<string>();
  const byPath = new Map<string, RepoSpan[]>();
  const codeIndex = new Map<string, RepoSpan[]>();
  const configIndex = new Map<string, RepoSpan[]>();

  for (const span of spans) {
    const normalizedPath = normalizePath(span.path);
    byPath.set(normalizedPath, [...(byPath.get(normalizedPath) ?? []), span]);
    if (span.kind.startsWith('code.')) {
      for (const key of codeLookupKeys(span)) addToIndex(codeIndex, key, span);
    }
    if (span.kind.startsWith('config.')) {
      for (const key of configLookupKeys(span)) addToIndex(configIndex, key, span);
    }
  }

  for (const span of spans) {
    if (span.kind === 'doc.link') {
      const targetType = metadataString(span, 'targetType');
      const targetPath = metadataString(span, 'path');
      const anchor = metadataString(span, 'anchor');
      const resolvedPath = targetType === 'relative' && targetPath ? relativeTarget(span.path, targetPath) : normalizePath(span.path);
      const targets = linkTargetsForPath(byPath.get(resolvedPath) ?? [], anchor);
      for (const target of targets) {
        pushCandidate(
          candidates,
          candidateKeys,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId: target.spanId,
            relation: 'links_to',
            evidenceKind: 'explicit_markdown_link',
            evidence: { path: resolvedPath, anchor }
          })
        );
      }
    }

    for (const mention of metadataArray(span, 'inlineCodeMentions')) {
      for (const target of codeIndex.get(mention) ?? []) {
        if (!codeMatches(target, mention)) continue;
        pushCandidate(
          candidates,
          candidateKeys,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId: target.spanId,
            relation: 'mentions',
            evidenceKind: 'exact_qualified_symbol_inline_code',
            evidence: { mention }
          })
        );
      }
      for (const target of configIndex.get(mention) ?? []) {
        if (!configMatches(target, mention)) continue;
        pushCandidate(
          candidates,
          candidateKeys,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId: target.spanId,
            relation: 'mentions',
            evidenceKind: 'exact_config_cli_env_mention',
            evidence: { mention }
          })
        );
      }
    }

    if (span.kind.startsWith('test.')) {
      for (const token of tokensMatching(span.indexedText, /\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        for (const target of codeIndex.get(token) ?? []) {
          if (!textCalls(span, target.label)) continue;
          pushCandidate(
            candidates,
            candidateKeys,
            createEvidenceCandidate({
              sourceSpanId: span.spanId,
              targetSpanId: target.spanId,
              relation: 'tests',
              evidenceKind: 'test_case_calls_source_symbol',
              evidence: { symbol: target.label }
            })
          );
        }
      }
    }

    if (span.kind.startsWith('example.')) {
      for (const token of tokensMatching(span.indexedText, /\b([A-Za-z_$][\w$]*)\b/g)) {
        for (const target of codeIndex.get(token) ?? []) {
          if (!span.indexedText.includes(target.label)) continue;
          pushCandidate(
            candidates,
            candidateKeys,
            createEvidenceCandidate({
              sourceSpanId: span.spanId,
              targetSpanId: target.spanId,
              relation: 'example_of',
              evidenceKind: 'example_imports_or_calls_source_symbol',
              evidence: { symbol: target.label }
            })
          );
        }
      }
    }

    if (span.kind === 'feature.node') {
      for (const targetSpanId of linkedSpanIds(span, 'implementedBySpanIds')) {
        pushCandidate(
          candidates,
          candidateKeys,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId,
            relation: 'feature_implemented_by',
            evidenceKind: 'rpg_feature_explicit_map',
            evidence: { metadataKey: 'implementedBySpanIds' }
          })
        );
      }
      for (const targetSpanId of linkedSpanIds(span, 'documentedBySpanIds')) {
        pushCandidate(
          candidates,
          candidateKeys,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId,
            relation: 'feature_documented_by',
            evidenceKind: 'rpg_feature_explicit_map',
            evidence: { metadataKey: 'documentedBySpanIds' }
          })
        );
      }
    }
  }

  return candidates.sort(
    (left, right) =>
      left.sourceSpanId.localeCompare(right.sourceSpanId) ||
      left.targetSpanId.localeCompare(right.targetSpanId) ||
      left.relation.localeCompare(right.relation) ||
      left.evidenceKind.localeCompare(right.evidenceKind)
  );
}
