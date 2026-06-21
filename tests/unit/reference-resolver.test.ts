import { resolveCodeFactEdges } from '../../packages/core/src/code-fact/reference-resolver.js';
import type { CodeFactSpan } from '../../packages/core/src/code-fact/extractor.js';

function span(input: Partial<CodeFactSpan> & { spanId: string; kind: CodeFactSpan['kind']; path: string; label: string }): CodeFactSpan {
  return {
    startLine: 1,
    endLine: 1,
    text: input.label,
    metadata: {},
    ...input
  };
}

describe('code fact reference resolver', () => {
  it('resolves imported aliases by FQN instead of first global label match', () => {
    const spans: CodeFactSpan[] = [
      span({ spanId: 'module-a', kind: 'code.module', path: 'src/a.ts', label: 'a', metadata: { qualifiedName: 'src/a.ts' } }),
      span({ spanId: 'module-b', kind: 'code.module', path: 'src/b.ts', label: 'b', metadata: { qualifiedName: 'src/b.ts' } }),
      span({ spanId: 'module-user', kind: 'code.module', path: 'src/user.ts', label: 'user', metadata: { qualifiedName: 'src/user.ts' } }),
      span({ spanId: 'a-target', kind: 'code.function', path: 'src/a.ts', label: 'target', metadata: { qualifiedName: 'src/a.ts:target' } }),
      span({ spanId: 'b-target', kind: 'code.function', path: 'src/b.ts', label: 'target', metadata: { qualifiedName: 'src/b.ts:target' } }),
      span({ spanId: 'caller', kind: 'code.function', path: 'src/user.ts', label: 'run', metadata: { qualifiedName: 'src/user.ts:run' } }),
      span({
        spanId: 'import-b',
        kind: 'code.import',
        path: 'src/user.ts',
        label: './b',
        metadata: {
          source: './b',
          resolvedSource: 'src/b',
          aliases: [{ importedName: 'target', localName: 'localTarget', source: './b', resolvedSource: 'src/b' }]
        }
      }),
      span({
        spanId: 'call-local-target',
        kind: 'code.callsite',
        path: 'src/user.ts',
        label: 'localTarget',
        startLine: 8,
        metadata: { callerLabel: 'run', qualifiedName: 'src/user.ts:call:8:3:localTarget' }
      })
    ];

    const edges = resolveCodeFactEdges(spans);
    const call = edges.find(edge => edge.relation === 'calls' && edge.sourceSpanId === 'caller');
    expect(call).toMatchObject({
      targetSpanId: 'b-target',
      targetLabel: 'target',
      evidence: { callLine: 8, resolvedBy: 'import_alias' }
    });
    expect(call?.targetSpanId).not.toBe('a-target');
  });
});
