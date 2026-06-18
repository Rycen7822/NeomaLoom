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

    expect(table).toMatchObject({
      startLine: 3,
      endLine: 6,
      text: '| Name | Type |\n| --- | --- |\n| timeoutMs | number |\n| retries | number |',
      metadata: {
        columns: ['Name', 'Type'],
        normalizedTableText: 'Name | Type\ntimeoutMs | number\nretries | number'
      }
    });
  });
});
