import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { indexCodeFacts, searchCodeFacts } from '../../packages/core/src/code-fact/code-fact-indexer.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-codegraph-index-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
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
          confidence: 0.9
        }),
        expect.objectContaining({
          relation: 'calls',
          sourceLabel: 'run',
          targetLabel: 'add',
          confidence: 0.92
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
    });

  it('extracts basic symbols from Go, Rust, and Java-family files', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(
      projectRoot,
      'src/server.go',
      ['package main', '', 'func Serve() {', '  Handle()', '}', '', 'func Handle() {}', ''].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/lib.rs',
      ['pub fn compute() -> i32 {', '  helper()', '}', '', 'fn helper() -> i32 { 1 }', ''].join('\n')
    );
    await writeProjectFile(
      projectRoot,
      'src/Client.java',
      ['class Client {', '  void handle() {', '    save();', '  }', '  void save() {}', '}', ''].join('\n')
    );

    const result = await indexCodeFacts({ projectRoot });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'code.function', path: 'src/server.go', label: 'Serve' }),
        expect.objectContaining({ kind: 'code.function', path: 'src/lib.rs', label: 'compute' }),
        expect.objectContaining({ kind: 'code.class', path: 'src/Client.java', label: 'Client' }),
        expect.objectContaining({ kind: 'code.method', path: 'src/Client.java', label: 'handle' })
      ])
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'calls', sourceLabel: 'Serve', targetLabel: 'Handle' }),
        expect.objectContaining({ relation: 'calls', sourceLabel: 'compute', targetLabel: 'helper' }),
        expect.objectContaining({ relation: 'calls', sourceLabel: 'handle', targetLabel: 'save' })
      ])
    );
  });
});
