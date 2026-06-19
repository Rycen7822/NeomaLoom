import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { traceGraph } from '../../packages/core/src/impact/trace.js';
import { applySpanMigrations } from '../../packages/core/src/spans/db.js';

type Statement = {
  run: (...params: unknown[]) => void;
};

type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };

async function createTraceDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json,
         symbol_path_json, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 'typescript', '[]', '[]', '{}', ?, ?, ?, '{}', 'test', 0)`
    );
    const insertEdge = db.prepare(
      `INSERT INTO repo_edges
        (edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json, updated_at)
       VALUES (?, ?, ?, ?, ?, 'test', '{}', 0)`
    );
    db.exec('BEGIN');
    insertSpan.run('seed', 'src/seed.ts', 'code.function', 'source_file', 'seed', 'h-seed', 'seed', 'seed');
    for (let index = 0; index < 1005; index += 1) {
      const spanId = `contains-${index}`;
      insertSpan.run(spanId, `src/contains-${index}.ts`, 'code.function', 'source_file', spanId, `h-${index}`, spanId, spanId);
      insertEdge.run(`edge-contains-${index}`, 'seed', spanId, 'contains', 1);
    }
    insertSpan.run('doc-target', 'docs/target.md', 'doc.paragraph', 'canonical_api_doc', 'target doc', 'h-doc', 'target doc', 'target doc');
    insertEdge.run('edge-doc', 'seed', 'doc-target', 'documents_symbol', 0.1);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

describe('traceGraph SQL fast path', () => {
  it('applies relation filters before edge limits', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-trace-fast-path-'));
    await createTraceDb(projectRoot);

    const graph = traceGraph({
      projectRoot,
      target: 'seed',
      targetType: 'span',
      relationTypes: ['documents_symbol'],
      direction: 'downstream',
      depth: 1
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ edgeId: 'edge-doc', relation: 'documents_symbol', targetSpanId: 'doc-target' })
    ]);
    expect(graph.nodes.map(node => node.spanId)).toContain('doc-target');
  });
});
