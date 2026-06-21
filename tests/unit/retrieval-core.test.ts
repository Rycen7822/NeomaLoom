import { buildRetrievalCoreRecords } from '../../packages/core/src/spans/retrieval-core.js';
import type { RepoSpan } from '../../packages/core/src/spans/types.js';

function repoSpan(input: Partial<RepoSpan> & { spanId: string; path: string; kind: string; label: string }): RepoSpan {
  return {
    role: 'source_file',
    startLine: 1,
    endLine: 1,
    language: 'typescript',
    headingPath: [],
    symbolPath: [input.label],
    stableLocator: { path: input.path, kind: input.kind, headingPath: [], blockOrdinal: 0, normalizedTextHash: 'hash', nearbyHeadingHash: 'heading' },
    textHash: 'hash',
    indexedText: input.label,
    summary: input.label,
    metadata: {},
    source: 'test',
    updatedAt: 0,
    ...input,
    kind: input.kind as RepoSpan['kind']
  };
}

describe('retrieval core symbol records', () => {
  it('builds repo_symbols and import aliases from projected spans', () => {
    const records = buildRetrievalCoreRecords([
      repoSpan({ spanId: 'class', path: 'src/api.ts', kind: 'code.class', label: 'Api', metadata: { qualifiedName: 'src/api.ts:Api', signature: 'Api' } }),
      repoSpan({ spanId: 'method', path: 'src/api.ts', kind: 'code.method', label: 'run', metadata: { qualifiedName: 'src/api.ts:Api.run', className: 'Api', signature: 'run(task)' } }),
      repoSpan({
        spanId: 'import',
        path: 'src/use.ts',
        kind: 'code.import',
        label: './api',
        metadata: { aliases: [{ importedName: 'Api', localName: 'LocalApi', source: './api', resolvedSource: 'src/api' }] }
      })
    ]);

    expect(records.symbols).toEqual([
      expect.objectContaining({ symbolFqn: 'src/api.ts:Api', spanId: 'class', symbolName: 'Api', parentSymbolFqn: undefined }),
      expect.objectContaining({ symbolFqn: 'src/api.ts:Api.run', spanId: 'method', symbolName: 'run', parentSymbolFqn: 'src/api.ts:Api' })
    ]);
    expect(records.aliases).toEqual([
      expect.objectContaining({ aliasFqn: 'src/use.ts:LocalApi', targetFqn: 'src/api.ts:Api', aliasKind: 'named' })
    ]);
  });
});
