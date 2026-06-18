import { parseMarkdownDocument } from '../../packages/core/src/documents/markdown-parser.js';

describe('Markdown links and anchors', () => {
  it('creates GitHub-compatible heading anchors and resolves link target types', () => {
    const document = [
      '# Client API',
      '',
      'See [Guide](../guide.md#setup), [External](https://example.com/docs), and [Local](#client-api).',
      ''
    ].join('\n');

    const result = parseMarkdownDocument({ path: 'docs/api/client.md', text: document });
    const links = result.spans.filter(span => span.kind === 'doc.link');

    expect(result.spans.find(span => span.kind === 'doc.heading')).toMatchObject({
      anchor: 'client-api'
    });
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      label: 'Guide',
      startLine: 3,
      metadata: {
        targetType: 'relative',
        path: '../guide.md',
        anchor: 'setup'
      }
    });
    expect(links[1]).toMatchObject({
      label: 'External',
      metadata: {
        targetType: 'external',
        url: 'https://example.com/docs'
      }
    });
    expect(links[2]).toMatchObject({
      label: 'Local',
      metadata: {
        targetType: 'anchor',
        anchor: 'client-api'
      }
    });
  });
});
