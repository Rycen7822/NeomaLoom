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
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join('/');
}

function codeMatches(span: RepoSpan, mention: string): boolean {
  if (!span.kind.startsWith('code.')) {
    return false;
  }
  return span.label === mention || span.symbolPath.join('.') === mention || metadataString(span, 'qualifiedName') === mention;
}

function configMatches(span: RepoSpan, mention: string): boolean {
  if (!span.kind.startsWith('config.')) {
    return false;
  }
  return [span.label, metadataString(span, 'configKey'), metadataString(span, 'cliFlag'), metadataString(span, 'envVar'), metadataString(span, 'schemaFieldName')]
    .filter(Boolean)
    .includes(mention);
}

function textCalls(span: RepoSpan, label: string): boolean {
  return new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(span.indexedText);
}

function pushCandidate(candidates: LinkCandidate[], candidate: LinkCandidate): void {
  const key = `${candidate.sourceSpanId}\0${candidate.targetSpanId}\0${candidate.relation}\0${candidate.evidenceKind}`;
  if (
    candidates.some(
      existing => `${existing.sourceSpanId}\0${existing.targetSpanId}\0${existing.relation}\0${existing.evidenceKind}` === key
    )
  ) {
    return;
  }
  candidates.push(candidate);
}

function linkedSpanIds(span: RepoSpan, key: string): string[] {
  return metadataArray(span, key).filter(Boolean);
}

export function extractLinkCandidatesFromSpans(spans: RepoSpan[]): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const byPath = new Map<string, RepoSpan[]>();
  const codeSpans = spans.filter(span => span.kind.startsWith('code.'));
  const configSpans = spans.filter(span => span.kind.startsWith('config.'));

  for (const span of spans) {
    const path = normalizePath(span.path);
    byPath.set(path, [...(byPath.get(path) ?? []), span]);
  }

  for (const span of spans) {
    if (span.kind === 'doc.link') {
      const targetType = metadataString(span, 'targetType');
      const targetPath = metadataString(span, 'path');
      const anchor = metadataString(span, 'anchor');
      const resolvedPath = targetType === 'relative' && targetPath ? relativeTarget(span.path, targetPath) : normalizePath(span.path);
      const targets = (byPath.get(resolvedPath) ?? []).filter(target => !anchor || target.anchor === anchor);
      for (const target of targets) {
        pushCandidate(
          candidates,
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
      for (const target of codeSpans.filter(candidate => codeMatches(candidate, mention))) {
        pushCandidate(
          candidates,
          createEvidenceCandidate({
            sourceSpanId: span.spanId,
            targetSpanId: target.spanId,
            relation: 'mentions',
            evidenceKind: 'exact_qualified_symbol_inline_code',
            evidence: { mention }
          })
        );
      }
      for (const target of configSpans.filter(candidate => configMatches(candidate, mention))) {
        pushCandidate(
          candidates,
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
      for (const target of codeSpans.filter(candidate => textCalls(span, candidate.label))) {
        pushCandidate(
          candidates,
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

    if (span.kind.startsWith('example.')) {
      for (const target of codeSpans.filter(candidate => span.indexedText.includes(candidate.label))) {
        pushCandidate(
          candidates,
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

    if (span.kind === 'feature.node') {
      for (const targetSpanId of linkedSpanIds(span, 'implementedBySpanIds')) {
        pushCandidate(
          candidates,
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
