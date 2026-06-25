import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { indexCodeFacts, searchCodeFacts } from '../../packages/core/src/code-fact/code-fact-indexer.js';
import { writeCodeGraphDb } from '../../packages/core/src/code-fact/codegraph-db.js';
import type { CodeFactSpan } from '../../packages/core/src/code-fact/extractor.js';
import type { FileInventory } from '../../packages/core/src/files/file-inventory.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    close: () => void;
  };
};

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-codegraph-index-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

function scalar(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get() as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

describe('CodeGraph-derived code fact indexer', () => {
  it('creates code spans, call/import edges, and searchable symbol facts without raw CodeGraph output', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(
      projectRoot,
      'src/math.ts',
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export class Calculator {',
        '  total(values: number[]): number {',
        '    return values.reduce(add, 0);',
        '  }',
        '}',
        ''
      ].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/client.ts',
      [
        "import { add, Calculator } from './math';",
        '',
        'export function run(): number {',
        '  const calc = new Calculator();',
        '  return add(calc.total([1, 2]), 3);',
        '}',
        ''
      ].join('\n')
    );

    const result = await indexCodeFacts({ projectRoot });

    expect(result.dbPath).toBe(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'));
    await expect(access(result.dbPath)).resolves.toBeUndefined();
    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'code.module',
          path: 'src/math.ts',
          label: 'math'
        }),
        expect.objectContaining({
          kind: 'code.function',
          path: 'src/math.ts',
          label: 'add',
          metadata: expect.objectContaining({
            qualifiedName: 'src/math.ts:add',
            signature: 'add(a: number, b: number): number'
          })
        }),
        expect.objectContaining({
          kind: 'code.class',
          label: 'Calculator'
        }),
        expect.objectContaining({
          kind: 'code.method',
          label: 'total',
          metadata: expect.objectContaining({
            qualifiedName: 'src/math.ts:Calculator.total'
          })
        }),
        expect.objectContaining({
          kind: 'code.import',
          path: 'src/client.ts',
          label: './math'
        }),
        expect.objectContaining({
          kind: 'code.callsite',
          path: 'src/client.ts',
          label: 'add'
        })
      ])
    );
    expect(result.spans).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'code.callsite',
          path: 'src/math.ts',
          label: 'total',
          startLine: 6
        })
      ])
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'imports',
          sourceLabel: './math',
          targetLabel: 'add',
          confidence: 0.94
        }),
        expect.objectContaining({
          relation: 'calls',
          sourceLabel: 'run',
          targetLabel: 'add',
          confidence: 0.96
        })
      ])
    );

    const search = searchCodeFacts({ dbPath: result.dbPath, query: 'Calculator' });
    expect(search).toEqual([
      expect.objectContaining({
        label: 'Calculator',
        kind: 'code.class',
        signature: 'Calculator'
      })
      ]);
    expect(() => searchCodeFacts({ dbPath: result.dbPath, query: 'foo-bar "unterminated' })).not.toThrow();
    });

  it('uses explicit empty indexedText without rereading missing files', async () => {
    const projectRoot = await createTempProject();
    const inventory: FileInventory = {
      ignoredPaths: [],
      files: [
        {
          path: 'src/empty.ts',
          absolutePath: path.join(projectRoot, 'src/empty.ts'),
          role: 'source_file',
          language: 'typescript',
          contentHash: 'sha1-empty',
          sizeBytes: 0,
          modifiedAt: 0,
          indexedAt: 0,
          generated: false,
          ignored: false,
          oversized: false,
          fileOnlySpan: false,
          spanKind: 'file',
          indexedText: ''
        }
      ]
    };

    const result = await indexCodeFacts({ projectRoot, inventory });

    expect(result.dbPath).toBe(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'));
    await expect(access(result.dbPath)).resolves.toBeUndefined();
  });

  it('keeps same-line duplicate callsites distinct and writes a searchable codegraph DB', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(
      projectRoot,
      'src/a.ts',
      [
        'export function foo() { return 1; }',
        'export function bar() { return foo() + foo(); }',
        ''
      ].join('\n')
    );

    const result = await indexCodeFacts({ projectRoot });
    const callsites = result.spans.filter(span => span.kind === 'code.callsite' && span.label === 'foo');

    expect(callsites).toHaveLength(2);
    expect(new Set(callsites.map(span => span.spanId)).size).toBe(2);
    expect(callsites.map(span => span.metadata.startColumn)).toEqual(expect.arrayContaining([32, 40]));
    expect(scalar(result.dbPath, "SELECT COUNT(*) AS value FROM facts_nodes WHERE kind = 'code.callsite' AND label = 'foo'")).toBe(2);
  });

  it('keeps the previous codegraph DB when a failed write hits duplicate span ids', async () => {
    const projectRoot = await createTempProject();
    const span: CodeFactSpan = {
      spanId: 'code:stable',
      kind: 'code.function',
      path: 'src/a.ts',
      label: 'foo',
      startLine: 1,
      endLine: 1,
      text: 'export function foo() {}',
      metadata: { qualifiedName: 'src/a.ts:foo', signature: 'foo()' }
    };
    const firstDbPath = await writeCodeGraphDb({
      projectRoot,
      files: [{ path: 'src/a.ts', language: 'typescript' }],
      spans: [span],
      edges: []
    });

    await expect(
      writeCodeGraphDb({
        projectRoot,
        files: [{ path: 'src/a.ts', language: 'typescript' }],
        spans: [span, { ...span, label: 'fooDuplicate' }],
        edges: []
      })
    ).rejects.toThrow(/UNIQUE|constraint|duplicate/i);
    expect(scalar(firstDbPath, 'SELECT COUNT(*) AS value FROM facts_nodes')).toBe(1);
  });

  it('extracts basic symbols from Go, Rust, and Java-family files', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(
      projectRoot,
      'src/server.go',
      [
        'package main',
        '',
        'type Server struct{}',
        'func (s *Server) Start() error {',
        '  Handle()',
        '  return nil',
        '}',
        '',
        'func Serve() {',
        '  Handle()',
        '}',
        '',
        'func Handle() {}',
        ''
      ].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/lib.rs',
      [
        'pub(crate) fn internal() -> i32 { helper() }',
        'unsafe fn dangerous() {}',
        'const fn computed() -> usize { 1 }',
        'async fn fetch() {}',
        'pub async fn handler() {}',
        'pub fn compute() -> i32 {',
        '  helper()',
        '}',
        '',
        'fn helper() -> i32 { 1 }',
        ''
      ].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/Client.java',
      [
        'class Client {',
        '  public synchronized String[] names() { return new String[0]; }',
        '  native int call();',
        '  void handle() {',
        '    save();',
        '  }',
        '  void save() {}',
        '}',
        ''
      ].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/Demo.kt',
      ['class Demo {', '  suspend fun load(): String = ""', '  fun plain() {}', '}', ''].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/Demo.scala',
      ['class Demo {', '  def run(x: Int): Int = x', '}', ''].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/settings.py',
      [
        'def foo(',
        '    x: str = """hello',
        '(world',
        '""",',
        '    y: int = 0,',
        '):',
        '    return y',
        '',
        'def bar():',
        '    return 1',
        ''
      ].join('\n')
    );

    const result = await indexCodeFacts({ projectRoot });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'code.function', path: 'src/server.go', label: 'Serve' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/server.go', label: 'Start' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'compute' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'internal' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'dangerous' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'computed' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'fetch' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'handler' }),
        expect.objectContaining({ kind: 'code.class', path: 'src/Client.java', label: 'Client' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Client.java', label: 'handle' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Client.java', label: 'names' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Client.java', label: 'call' }),
        expect.objectContaining({ kind: 'code.class', path: 'src/Demo.kt', label: 'Demo' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Demo.kt', label: 'load' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Demo.scala', label: 'run' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/settings.py', label: 'foo', endLine: 7 }),
        expect.objectContaining({ kind: 'code.function', path: 'src/settings.py', label: 'bar', endLine: 10 })
      ])
    );
    const foo = result.spans.find(span => span.path === 'src/settings.py' && span.label === 'foo');
    expect(foo?.metadata.signature).not.toContain('def bar');
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'calls', sourceLabel: 'Start', targetLabel: 'Handle' }),
        expect.objectContaining({ relation: 'calls', sourceLabel: 'Serve', targetLabel: 'Handle' }),
        expect.objectContaining({ relation: 'calls', sourceLabel: 'compute', targetLabel: 'helper' }),
        expect.objectContaining({ relation: 'calls', sourceLabel: 'handle', targetLabel: 'save' })
      ])
    );
  });
});
