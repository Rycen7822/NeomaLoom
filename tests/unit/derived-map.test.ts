import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildProjectionGraph,
  type FeatureProjectionRecord
} from '../../packages/core/src/spans/projection-builder.js';
import {
  buildRepositoryMap,
  writeRepositoryMap
} from '../../packages/core/src/derived-map/repository-map.js';
import { renderRepositoryMapMarkdown } from '../../packages/core/src/derived-map/repository-map-markdown.js';
import type { FileRole, SpanKind } from '../../packages/core/src/spans/enums.js';
import { createConfigSpanId } from '../../packages/core/src/spans/span-id.js';
import type { RepoEdge, RepoSpan } from '../../packages/core/src/spans/types.js';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function span(input: {
  spanId: string;
  path: string;
  kind: SpanKind;
  role: FileRole;
  label: string;
  summary?: string;
  indexedText?: string;
}): RepoSpan {
  return {
    spanId: input.spanId,
    path: input.path,
    kind: input.kind,
    role: input.role,
    label: input.label,
    startLine: 1,
    endLine: 1,
    language: 'text',
    headingPath: input.kind.startsWith('doc.') ? [input.label] : [],
    symbolPath: input.kind.startsWith('code.') ? [input.label] : [],
    stableLocator: {
      path: input.path,
      kind: input.kind,
      headingPath: input.kind.startsWith('doc.') ? [input.label] : [],
      blockOrdinal: 0,
      normalizedTextHash: input.spanId,
      nearbyHeadingHash: input.spanId
    },
    textHash: input.spanId,
    indexedText: input.indexedText ?? input.label,
    summary: input.summary ?? input.label,
    metadata: {},
    source: 'test',
    updatedAt: 0
  };
}

function edge(input: {
  sourceSpanId: string;
  targetSpanId: string;
  relation: RepoEdge['relation'];
  confidence: number;
}): RepoEdge {
  return {
    edgeId: `edge:${input.sourceSpanId}:${input.targetSpanId}`,
    sourceSpanId: input.sourceSpanId,
    targetSpanId: input.targetSpanId,
    relation: input.relation,
    confidence: input.confidence,
    source: 'test',
    evidence: { kind: 'explicit_markdown_link' },
    updatedAt: 0
  };
}

describe('derived repository map', () => {
  it('keeps document span ids stable when unrelated files gain spans', () => {
    const files = ['a.md', 'b.md'].map(file => ({
      path: file,
      absolutePath: `/repo/${file}`,
      role: 'canonical_api_doc' as const,
      language: 'markdown',
      contentHash: file,
      sizeBytes: 10,
      modifiedAt: 0,
      indexedAt: 0,
      generated: false as const,
      ignored: false as const,
      oversized: false as const,
      fileOnlySpan: false,
      spanKind: 'file' as const,
      indexedText: `# ${file}`
    }));
    const documentSpan = (file: string, label: string, startLine: number) => ({
      kind: 'doc.heading' as const,
      path: file,
      label,
      startLine,
      endLine: startLine,
      headingPath: [label],
      anchor: label.toLowerCase(),
      text: label,
      metadata: {}
    });

    const first = buildProjectionGraph({
      projectRoot: '/repo',
      files,
      codeSpans: [],
      documentSpans: [documentSpan('a.md', 'A1', 1), documentSpan('b.md', 'B1', 1)],
      artifactSpans: [],
      testExampleSpans: [],
      features: []
    });
    const second = buildProjectionGraph({
      projectRoot: '/repo',
      files,
      codeSpans: [],
      documentSpans: [documentSpan('a.md', 'A1', 1), documentSpan('a.md', 'A2', 2), documentSpan('b.md', 'B1', 1)],
      artifactSpans: [],
      testExampleSpans: [],
      features: []
    });

    const firstB = first.spans.find(item => item.path === 'b.md' && item.label === 'B1');
    const secondB = second.spans.find(item => item.path === 'b.md' && item.label === 'B1');
    expect(second.spans.find(item => item.path === 'a.md' && item.label === 'A2')?.stableLocator.blockOrdinal).toBe(1);
    expect(firstB?.stableLocator.blockOrdinal).toBe(0);
    expect(secondB?.stableLocator.blockOrdinal).toBe(0);
    expect(secondB?.spanId).toBe(firstB?.spanId);
  });

  it('merges projections into deterministic repo spans and contains edges', () => {
    const features: FeatureProjectionRecord[] = [
      { id: 'feature.client', title: 'Client API', source: 'deterministic' }
    ];

    const graph = buildProjectionGraph({
      projectRoot: '/repo',
      files: [
        {
          path: 'src/client.ts',
          absolutePath: '/repo/src/client.ts',
          role: 'source_file',
          language: 'typescript',
          contentHash: 'hash',
          sizeBytes: 10,
          modifiedAt: 0,
          indexedAt: 0,
          generated: false,
          ignored: false,
          oversized: false,
          fileOnlySpan: false,
          spanKind: 'file',
          indexedText: 'export function createClient() {}'
        }
      ],
      codeSpans: [
        {
          spanId: 'code:createClient',
          kind: 'code.function',
          path: 'src/client.ts',
          label: 'createClient',
          startLine: 1,
          endLine: 1,
          text: 'createClient',
          metadata: { qualifiedName: 'createClient' }
        }
      ],
      documentSpans: [
        {
          kind: 'doc.heading',
          path: 'docs/api/client.md',
          label: 'Client API',
          startLine: 1,
          endLine: 1,
          headingPath: ['Client API'],
          anchor: 'client-api',
          text: '# Client API',
          metadata: {}
        }
      ],
      artifactSpans: [
        {
          kind: 'config.entry',
          path: 'package.json',
          label: 'scripts.test',
          startLine: 4,
          endLine: 4,
          text: '"test": "vitest"',
          metadata: { pointer: '/scripts/test' }
        }
      ],
      testExampleSpans: [
        {
          kind: 'test.case',
          path: 'tests/client.test.ts',
          label: 'creates client',
          startLine: 1,
          endLine: 1,
          text: 'test("creates client", () => createClient())',
          metadata: {}
        }
      ],
      features
    });

    expect(graph.spans.map(item => [item.kind, item.path, item.label])).toEqual([
      ['feature.node', '.noemaloom/planning/features.json', 'Client API'],
      ['file', 'src/client.ts', 'src/client.ts'],
      ['code.function', 'src/client.ts', 'createClient'],
      ['doc.heading', 'docs/api/client.md', 'Client API'],
      ['config.entry', 'package.json', 'scripts.test'],
      ['test.case', 'tests/client.test.ts', 'creates client']
    ]);
    expect(graph.spans.find(item => item.label === 'scripts.test')?.spanId).toBe(
      createConfigSpanId({
        projectRoot: '/repo',
        path: 'package.json',
        jsonPointerOrTomlPath: '/scripts/test#label:scripts.test#line:4',
        normalizedValueHash: sha1('"test": "vitest"')
      })
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        sourceSpanId: graph.spans[1].spanId,
        targetSpanId: 'code:createClient',
        relation: 'contains',
        confidence: 1
      })
    );
  });

  it('builds and writes a deterministic safe context recovery map', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-derived-map-'));
    const spans = [
      span({ spanId: 'code:createClient', path: 'src/client.ts', kind: 'code.function', role: 'source_file', label: 'createClient' }),
      span({ spanId: 'doc:client', path: 'docs/api/client.md', kind: 'doc.heading', role: 'canonical_api_doc', label: 'Client API' }),
      span({ spanId: 'test:client', path: 'tests/client.test.ts', kind: 'test.case', role: 'test_file', label: 'creates client' }),
      span({ spanId: 'config:pkg', path: 'package.json', kind: 'config.entry', role: 'package_metadata', label: 'scripts.test' }),
      span({ spanId: 'feature:client', path: '.noemaloom/planning/features.json', kind: 'feature.node', role: 'feature_plan', label: 'Client API' }),
      span({ spanId: 'agent:skill', path: '.agents/skills/client/SKILL.md', kind: 'doc.heading', role: 'design_doc', label: 'Client Skill' }),
      span({ spanId: 'artifact:run', path: 'artifacts/daily/client.md', kind: 'doc.heading', role: 'design_doc', label: 'Client Artifact' }),
      span({
        spanId: 'doc:forbidden',
        path: 'notes/chat.md',
        kind: 'doc.heading',
        role: 'experiment_note_doc',
        label: 'chat summary user preference',
        indexedText: 'full code snippet: console.log("secret")'
      })
    ];
    const edges = [
      edge({ sourceSpanId: 'doc:client', targetSpanId: 'code:createClient', relation: 'documents', confidence: 1 }),
      edge({ sourceSpanId: 'test:client', targetSpanId: 'code:createClient', relation: 'tests', confidence: 0.92 }),
      edge({ sourceSpanId: 'doc:client', targetSpanId: 'config:pkg', relation: 'mentions', confidence: 0.59 })
    ];

    const map = buildRepositoryMap({
      projectRoot,
      graphRevision: 'rev-map',
      spans: [...spans].reverse(),
      edges: [...edges].reverse(),
      warnings: ['parse warning: docs/api/client.md']
    });
    const mapAgain = buildRepositoryMap({ projectRoot, graphRevision: 'rev-map', spans, edges, warnings: ['parse warning: docs/api/client.md'] });

    expect(map).toEqual(mapAgain);
    expect(map.graphRevision).toBe('rev-map');
    expect(map.directoryRoles).toContainEqual({ path: 'src', roles: ['source_file'], spanCount: 1 });
    expect(map.canonicalDocs).toEqual([{ path: 'docs/api/client.md', label: 'Client API', role: 'canonical_api_doc' }]);
    expect(map.coreSourceModules).toEqual([{ path: 'src/client.ts', label: 'createClient', kind: 'code.function' }]);
    expect(map.testEntries).toEqual([{ path: 'tests/client.test.ts', label: 'creates client', kind: 'test.case' }]);
    expect(map.configEntries).toEqual([{ path: 'package.json', label: 'scripts.test', kind: 'config.entry' }]);
    expect(map.featureClusters).toEqual([]);
    expect(map.highConfidenceLinks).toEqual([
      {
        sourceSpanId: 'doc:client',
        targetSpanId: 'code:createClient',
        relation: 'documents',
        confidence: 1,
        evidenceKind: 'explicit_markdown_link'
      },
      {
        sourceSpanId: 'test:client',
        targetSpanId: 'code:createClient',
        relation: 'tests',
        confidence: 0.92,
        evidenceKind: 'explicit_markdown_link'
      }
    ]);
    expect(map.warnings).toEqual(['parse warning: docs/api/client.md']);

    const rendered = renderRepositoryMapMarkdown(map);
    await writeRepositoryMap({ projectRoot, map });
    expect(await readFile(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.md'), 'utf8')).toBe(rendered);
    expect(JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'), 'utf8'))).toEqual(map);
    expect(`${JSON.stringify(map)}\n${rendered}`).not.toMatch(/chat summary|user preference|full code snippet|console\.log|\.agents\/skills|artifacts\/daily|\.noemaloom\/planning\/features\.json/);
  });
});
