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

export function resolveCodeFactEdges(spans: CodeFactSpan[]): CodeFactEdge[] {
  const edges: CodeFactEdge[] = [];
  const modules = new Map<string, CodeFactSpan>();
  const symbolsByLabel = new Map<string, CodeFactSpan[]>();

  for (const span of spans) {
    if (span.kind === 'code.module') {
      modules.set(span.path, span);
      continue;
    }
    if (!['code.import', 'code.callsite'].includes(span.kind)) {
      const existing = symbolsByLabel.get(span.label) ?? [];
      existing.push(span);
      symbolsByLabel.set(span.label, existing);
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

    if (span.kind === 'code.import') {
      const importedNames = Array.isArray(span.metadata.importedNames) ? span.metadata.importedNames : [];
      for (const importedName of importedNames) {
        const target = symbolsByLabel.get(String(importedName))?.[0];
        if (!target) {
          continue;
        }
        edges.push(
          createEdge({
            sourceSpanId: span.spanId,
            targetSpanId: target.spanId,
            relation: 'imports',
            sourceLabel: span.label,
            targetLabel: target.label,
            confidence: 0.9,
            evidence: {
              importedName
            }
          })
        );
      }
    }

    if (span.kind === 'code.callsite') {
      const target = symbolsByLabel.get(span.label)?.[0];
      const callerLabel = typeof span.metadata.callerLabel === 'string' ? span.metadata.callerLabel.split('.').at(-1) : undefined;
      const source = callerLabel ? symbolsByLabel.get(callerLabel)?.[0] : undefined;
      if (!target || !source) {
        continue;
      }
      edges.push(
        createEdge({
          sourceSpanId: source.spanId,
          targetSpanId: target.spanId,
          relation: 'calls',
          sourceLabel: source.label,
          targetLabel: target.label,
          confidence: 0.92,
          evidence: {
            callLine: span.startLine
          }
        })
      );
    }
  }

  return edges;
}
