import { parseMarkdownDocument } from '../../packages/core/src/documents/markdown-parser.js';

describe('Markdown block indexer', () => {
  it('creates headings, sections, list, code fence, quote, and paragraph spans with exact lines', () => {
    const document = [
      '# Client API',
      '',
      'Intro paragraph with `timeoutMs`.',
      '',
      '## Install',
      '',
      '- Run setup',
      '- Check output',
      '',
      '```ts',
      "import { createClient } from './client';",
      'noemaloom --help',
      'timeoutMs: 100',
      '```',
      '',
      '> Important note',
      ''
    ].join('\n');

    const result = parseMarkdownDocument({ path: 'docs/api/client.md', text: document });

    expect(result.warnings).toEqual([]);
    expect(result.spans.filter(span => span.kind === 'doc.heading')).toMatchObject([
      { label: 'Client API', startLine: 1, endLine: 1, anchor: 'client-api' },
      { label: 'Install', startLine: 5, endLine: 5, anchor: 'install' }
    ]);
    expect(result.spans.filter(span => span.kind === 'doc.section')).toMatchObject([
      { label: 'Client API', startLine: 1, endLine: 16 },
      { label: 'Install', startLine: 5, endLine: 16 }
    ]);
    expect(result.spans.find(span => span.kind === 'doc.paragraph')).toMatchObject({
      startLine: 3,
      endLine: 3,
      metadata: {
        inlineCodeMentions: ['timeoutMs']
      }
    });
    expect(result.spans.find(span => span.kind === 'doc.list')).toMatchObject({
      startLine: 7,
      endLine: 8,
      text: '- Run setup\n- Check output'
    });
    expect(result.spans.find(span => span.kind === 'doc.code_fence')).toMatchObject({
      startLine: 10,
      endLine: 14,
      metadata: {
        language: 'ts',
        preview: "import { createClient } from './client';",
        importMentions: ["./client"],
        cliMentions: ['noemaloom --help'],
        configKeyMentions: ['timeoutMs']
      }
    });
    expect(result.spans.find(span => span.kind === 'doc.quote')).toMatchObject({
      startLine: 16,
      endLine: 16
    });
  });
});
