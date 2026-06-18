import { parseMdxDocument } from '../../packages/core/src/documents/mdx-parser.js';

describe('MDX block indexer', () => {
  it('degrades MDX JSX blocks to whole block spans with parse warnings', () => {
    const document = [
      "import Widget from './Widget'",
      '',
      '# MDX Page',
      '',
      '<Widget prop="value" />',
      '',
      'Plain Markdown paragraph.',
      ''
    ].join('\n');

    const result = parseMdxDocument({ path: 'docs/mdx/page.mdx', text: document });
    const degraded = result.spans.filter(span => span.metadata.mdxDegraded === true);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'mdx_degraded_block',
          severity: 'warning',
          startLine: 5,
          endLine: 5
        })
      ])
    );
    expect(degraded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'doc.paragraph',
          startLine: 5,
          endLine: 5,
          text: '<Widget prop="value" />',
          metadata: expect.objectContaining({
            mdxNodeType: 'mdxJsxFlowElement'
          })
        })
      ])
    );
    expect(result.spans.find(span => span.kind === 'doc.paragraph' && span.startLine === 7)).toMatchObject({
      text: 'Plain Markdown paragraph.'
    });
  });
});
