import { parseMarkdownDocument } from '../../packages/core/src/documents/markdown-parser.js';

describe('Markdown table indexer', () => {
  it('preserves complete table row range and column names', () => {
    const document = [
      '# Options',
      '',
      '| Name | Type |',
      '| --- | --- |',
      '| timeoutMs | number |',
      '| retries | number |',
      ''
    ].join('\n');

    const result = parseMarkdownDocument({ path: 'docs/api/options.md', text: document });
    const table = result.spans.find(span => span.kind === 'doc.table');
    const rows = result.spans.filter(span => span.kind === 'doc.table_row');

    expect(table).toMatchObject({
      startLine: 3,
      endLine: 6,
      text: '| Name | Type |\n| --- | --- |\n| timeoutMs | number |\n| retries | number |',
      metadata: {
        columns: ['Name', 'Type'],
        normalizedTableText: 'Name | Type\ntimeoutMs | number\nretries | number'
      }
    });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'doc.table_row',
        label: 'timeoutMs | number',
        startLine: 5,
        endLine: 5,
        text: '| timeoutMs | number |',
        metadata: expect.objectContaining({
          columns: ['Name', 'Type'],
          rowIndex: 1,
          cells: ['timeoutMs', 'number'],
          normalizedRowText: 'timeoutMs | number'
        })
      }),
      expect.objectContaining({
        kind: 'doc.table_row',
        label: 'retries | number',
        startLine: 6,
        endLine: 6,
        text: '| retries | number |',
        metadata: expect.objectContaining({
          columns: ['Name', 'Type'],
          rowIndex: 2,
          cells: ['retries', 'number'],
          normalizedRowText: 'retries | number'
        })
      })
    ]);
  });
});
