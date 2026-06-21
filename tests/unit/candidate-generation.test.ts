import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateCandidates } from '../../packages/core/src/locator/candidate-generation.js';
import { handleNlStatus } from '../../packages/core/src/mcp/tools/nl-status.js';
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

async function createScopedSpanDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, ?, ?, ?, 32, 0, 0, 0, 0, '{}')`
    );
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json,
         symbol_path_json, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
       VALUES ('hot-readme', 'README.md', 'doc.paragraph', 'readme_doc', 'Demo', 1, 1, 'markdown', '[]',
         '[]', ?, 'hot-hash', 'Hot indexed README', 'Hot indexed README', '{}', 'test', 0)`
    );
    const insertRevision = db.prepare(
      `INSERT INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
       VALUES ('rev-scoped', ?, 'paths', 0, 1, 3, 1, 0, '[]')`
    );

    db.exec('BEGIN');
    insertFile.run('README.md', path.join(projectRoot, 'README.md'), 'readme_doc', 'markdown', 'hot-file-hash');
    insertFile.run('docs/cold-api.md', path.join(projectRoot, 'docs/cold-api.md'), 'canonical_api_doc', 'markdown', 'cold-file-hash');
    insertFile.run('tests/client.test.ts', path.join(projectRoot, 'tests/client.test.ts'), 'test_file', 'typescript', 'cold-test-hash');
    insertSpan.run(stableLocator('README.md', 0));
    insertRevision.run(projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function createExactPathLongSpanDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const repoPath = 'docs/long.md';
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, 'canonical_api_doc', 'markdown', 'long-hash', 4096, 0, 0, 0, 0, '{}')`
    );
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json,
         symbol_path_json, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
       VALUES (?, ?, 'doc.paragraph', 'canonical_api_doc', ?, ?, ?, 'markdown', '["Long Doc"]',
         '[]', ?, ?, ?, ?, '{}', 'test', 0)`
    );
    const insertRevision = db.prepare(
      `INSERT INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
       VALUES ('rev-long-exact-path', ?, 'all', 0, 1, 1, 320, 0, '[]')`
    );

    db.exec('BEGIN');
    insertFile.run(repoPath, path.join(projectRoot, repoPath));
    for (let index = 1; index <= 320; index += 1) {
      const text = `paragraph ${index}`;
      insertSpan.run(`long-span-${index}`, repoPath, text, index, index, stableLocator(repoPath, index), `long-hash-${index}`, text, text);
    }
    insertRevision.run(projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function createLargeScopedInventoryDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, ?, ?, ?, 32, 0, 0, 0, 0, '{}')`
    );
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json,
         symbol_path_json, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
       VALUES ('hot-stage10', 'DeepScientist/quests/001/STAGE10_推进规划.md', 'doc.section', 'design_doc', 'STAGE10 推进规划', 1, 8, 'markdown', '["STAGE10"]',
         '[]', ?, 'hot-stage10-hash', 'STAGE10 fp08 floorplan GPU CURRENT_STATUS bash_exec', 'STAGE10 plan', '{}', 'test', 0)`
    );
    const insertRevision = db.prepare(
      `INSERT INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
       VALUES ('rev-large-scoped', ?, 'hotset', 0, 1, 1202, 1, 0, '[]')`
    );

    db.exec('BEGIN');
    const hotPath = 'DeepScientist/quests/001/STAGE10_推进规划.md';
    insertFile.run(hotPath, path.join(projectRoot, hotPath), 'design_doc', 'markdown', 'hot-stage10-hash');
    insertFile.run('CURRENT_STATUS.md', path.join(projectRoot, 'CURRENT_STATUS.md'), 'readme_doc', 'markdown', 'status-hash');
    for (let index = 0; index < 1200; index += 1) {
      const repoPath = `stage10/runs/fp08/floorplan/bash_exec_${String(index).padStart(4, '0')}.jsonl`;
      insertFile.run(repoPath, path.join(projectRoot, repoPath), 'generated_file', 'jsonl', `cold-${index}`);
    }
    insertSpan.run(stableLocator(hotPath, 0));
    insertRevision.run(projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function createAliasRouteDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    db.exec('BEGIN');
    db.prepare(`INSERT INTO repo_files
      (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
      VALUES ('src/api.ts', ?, 'source_file', 'typescript', 'api-hash', 64, 0, 0, 0, 0, '{}')`).run(path.join(projectRoot, 'src/api.ts'));
    db.prepare(`INSERT INTO repo_spans
      (span_id, path, kind, role, label, start_line, end_line, language, heading_path_json, symbol_path_json,
       stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
      VALUES ('api-span', 'src/api.ts', 'code.class', 'source_file', 'ApiClient', 1, 3, 'typescript', '[]', '["ApiClient"]', ?,
       'api-text-hash', 'export class ApiClient {}', 'ApiClient', '{"qualifiedName":"src/api.ts:ApiClient","signature":"ApiClient"}', 'test', 0)`).run(stableLocator('src/api.ts', 0));
    db.prepare(`INSERT INTO repo_symbols
      (symbol_fqn, span_id, path, language, symbol_name, symbol_kind, parent_symbol_fqn, module_path, signature,
       exported, deprecated, deprecated_message, superseded_by, metadata_json)
      VALUES ('src/api.ts:ApiClient', 'api-span', 'src/api.ts', 'typescript', 'ApiClient', 'code.class', NULL, 'src/api', 'ApiClient', 1, 0, NULL, NULL, '{}')`).run();
    db.prepare(`INSERT INTO repo_symbol_aliases
      (alias_fqn, target_fqn, alias_kind, path, line, metadata_json)
      VALUES ('src/use.ts:LocalClient', 'src/api.ts:ApiClient', 'named', 'src/use.ts', 1, '{"localName":"LocalClient","importedName":"ApiClient"}')`).run();
    db.prepare(`INSERT INTO refresh_revisions
      (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
      VALUES ('rev-alias-route', ?, 'all', 0, 1, 1, 1, 0, '[]')`).run(projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

describe('candidate generation', () => {
  it('uses retrieval-core aliases as first-class lexical symbol routes', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-alias-route-'));
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src/api.ts'), 'export class ApiClient {}\n', 'utf8');
    await createAliasRouteDb(projectRoot);

    const generated = await generateCandidates({ projectRoot, query: 'LocalClient', targetRoles: ['source_file'] });
    const candidate = generated.candidates.find(item => item.spanId === 'api-span');

    expect(candidate).toMatchObject({
      spanId: 'api-span',
      label: 'ApiClient',
      sourcePlanSources: expect.arrayContaining(['code_symbol_name_signature'])
    });
  });

  it('warns when the selected root appears to contain multiple child projects and artifact noise', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-parent-root-warning-'));
    await mkdir(path.join(projectRoot, 'child-a'), { recursive: true });
    await mkdir(path.join(projectRoot, 'child-b'), { recursive: true });
    await mkdir(path.join(projectRoot, 'artifacts'), { recursive: true });
    await writeFile(path.join(projectRoot, 'child-a', 'package.json'), JSON.stringify({ name: 'child-a' }), 'utf8');
    await writeFile(path.join(projectRoot, 'child-b', 'pyproject.toml'), '[project]\nname = "child-b"\n', 'utf8');

    const generated = await generateCandidates({
      projectRoot,
      query: 'update client docs'
    });

    expect(generated.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multi_project_root_suspected' }),
      expect.objectContaining({ code: 'artifact_or_backup_noise_detected' })
    ]));

    const status = await handleNlStatus({ projectPath: projectRoot });
    expect(status.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multi_project_root_suspected' }),
      expect.objectContaining({ code: 'artifact_or_backup_noise_detected' })
    ]));
  });

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

  it('returns unindexed inventory candidates from scoped indexes instead of empty results', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-scoped-candidates-'));
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), '# Demo\n', 'utf8');
    await writeFile(path.join(projectRoot, 'docs/cold-api.md'), '# Cold API\n\nDocuments coldWidget.\n', 'utf8');
    await writeFile(path.join(projectRoot, 'tests/client.test.ts'), 'test("coldWidget", () => {});\n', 'utf8');
    await createScopedSpanDb(projectRoot);

    const generated = await generateCandidates({
      projectRoot,
      query: 'cold-api coldWidget',
      targetRoles: ['canonical_api_doc']
    });

    const cold = generated.candidates.find(candidate => candidate.path === 'docs/cold-api.md');
    expect(cold).toMatchObject({
      path: 'docs/cold-api.md',
      role: 'canonical_api_doc',
      indexed: false,
      promotionAction: expect.objectContaining({ target: 'paths', paths: ['docs/cold-api.md'] })
    });
    expect(generated.unindexedCandidates.map(candidate => candidate.path)).toContain('docs/cold-api.md');
    expect(generated.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unindexed_candidates' })]));
  });

  it('keeps late spans from explicit path matches instead of only early file spans', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-exact-path-spans-'));
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await writeFile(path.join(projectRoot, 'docs/long.md'), '# Long\n', 'utf8');
    await createExactPathLongSpanDb(projectRoot);

    const generated = await generateCandidates({
      projectRoot,
      query: 'docs/long.md',
      targetRoles: ['canonical_api_doc'],
      limit: 5
    });

    expect(generated.candidates.map(candidate => candidate.spanId)).toContain('long-span-260');
  });

  it('caps broad scoped inventory matches and keeps exact Codex work targets', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-large-scoped-candidates-'));
    await createLargeScopedInventoryDb(projectRoot);

    const generated = await generateCandidates({
      projectRoot,
      query: 'STAGE10_推进规划.md fp08 floorplan GPU PID CURRENT_STATUS bash_exec',
      limit: 20
    });

    expect(generated.candidates.length).toBeLessThanOrEqual(260);
    expect(generated.candidates.map(candidate => candidate.path)).toContain('DeepScientist/quests/001/STAGE10_推进规划.md');
    expect(generated.unindexedCandidates.length).toBeLessThanOrEqual(250);
    expect(generated.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unindexed_candidates' })]));
  });
});
