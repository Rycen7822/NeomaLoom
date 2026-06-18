import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateCandidates } from '../../packages/core/src/locator/candidate-generation.js';
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

function stableLocator(repoPath: string, index: number): string {
  return JSON.stringify({
    path: repoPath,
    kind: 'doc.paragraph',
    headingPath: ['Client API'],
    blockOrdinal: index,
    normalizedTextHash: `hash-${index}`,
    nearbyHeadingHash: 'heading'
  });
}

async function createSpanDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json,
         symbol_path_json, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
       VALUES (?, ?, 'doc.paragraph', 'canonical_api_doc', ?, 1, 1, 'markdown', '["Client API"]',
         '[]', ?, ?, ?, ?, '{}', 'test', 0)`
    );
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, 'canonical_api_doc', 'markdown', 'target-hash', 38, 0, 0, 0, 0, '{}')`
    );
    const insertRevision = db.prepare(
      `INSERT INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
       VALUES ('rev-many-spans', ?, 'all', 0, 1, 1, 5001, 0, '[]')`
    );

    db.exec('BEGIN');
    for (let index = 0; index < 5000; index += 1) {
      const repoPath = `docs/api/a-${String(index).padStart(4, '0')}.md`;
      const text = `filler paragraph ${index}`;
      insertSpan.run(`span-${index}`, repoPath, text, stableLocator(repoPath, index), `hash-${index}`, text, text);
    }
    const targetPath = 'docs/api/z-target.md';
    const targetText = 'needleTerm createClient target paragraph';
    insertSpan.run('span-5001', targetPath, targetText, stableLocator(targetPath, 5001), 'hash-5001', targetText, targetText);
    insertFile.run(targetPath, path.join(projectRoot, targetPath));
    insertRevision.run(projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

describe('candidate generation', () => {
  it('does not drop relevant spans that sort after the first five thousand rows', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-many-spans-'));
    await mkdir(path.join(projectRoot, 'docs/api'), { recursive: true });
    await writeFile(path.join(projectRoot, 'docs/api/z-target.md'), 'needleTerm createClient target paragraph', 'utf8');
    await createSpanDb(projectRoot);

    const generated = await generateCandidates({
      projectRoot,
      query: 'needleTerm createClient',
      targetRoles: ['canonical_api_doc']
    });

    expect(generated.candidates.map(candidate => candidate.spanId)).toContain('span-5001');
  });
});
