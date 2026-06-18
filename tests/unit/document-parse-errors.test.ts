import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { indexDocumentSpans } from '../../packages/core/src/documents/document-span-indexer.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-doc-errors-'));
}

describe('document parse error handling', () => {
  it('records parser failures under .noemaloom/documents and returns an error warning', async () => {
    const projectRoot = await createTempProject();

    const result = await indexDocumentSpans({
      path: 'docs/broken.mdx',
      projectRoot,
      text: 'import {'
    });

    expect(result.spans).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'document_parse_error',
        severity: 'error',
        message: expect.stringContaining('Could not parse import/exports with acorn')
      })
    ]);

    const errorLog = await readFile(path.join(projectRoot, '.noemaloom', 'documents', 'parse-errors.jsonl'), 'utf8');
    expect(JSON.parse(errorLog.trim())).toMatchObject({
      path: 'docs/broken.mdx',
      code: 'document_parse_error'
    });
  });
});
