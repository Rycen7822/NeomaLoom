import { parseRstDocument } from '../../packages/core/src/documents/rst-parser.js';

describe('RST block indexer', () => {
  it('creates sections, lists, literal blocks, paragraphs, and links without rendering RST', () => {
    const document = [
      'Client API',
      '==========',
      '',
      'Intro paragraph.',
      '',
      '- setup',
      '- verify',
      '',
      'Example::',
      '',
      '  noemaloom --help',
      '',
      'See `Guide <../guide.rst#setup>`_ and `External <https://example.com/docs>`_.',
      ''
    ].join('\n');

    const result = parseRstDocument({ path: 'docs/api/client.rst', text: document });

    expect(result.spans.find(span => span.kind === 'doc.heading')).toMatchObject({
      label: 'Client API',
      startLine: 1,
      endLine: 2
    });
    expect(result.spans.find(span => span.kind === 'doc.section')).toMatchObject({
      label: 'Client API',
      startLine: 1,
      endLine: 13
    });
    expect(result.spans.find(span => span.kind === 'doc.list')).toMatchObject({
      startLine: 6,
      endLine: 7,
      text: '- setup\n- verify'
    });
    expect(result.spans.find(span => span.kind === 'doc.code_fence')).toMatchObject({
      startLine: 9,
      endLine: 11,
      text: 'Example::\n\n  noemaloom --help',
      metadata: {
        language: 'rst-literal',
        cliMentions: ['noemaloom --help']
      }
    });
    expect(result.spans.filter(span => span.kind === 'doc.link')).toMatchObject([
      {
        label: 'Guide',
        startLine: 13,
        metadata: {
          targetType: 'relative',
          path: '../guide.rst',
          anchor: 'setup'
        }
      },
      {
        label: 'External',
        startLine: 13,
        metadata: {
          targetType: 'external',
          url: 'https://example.com/docs'
        }
      }
    ]);
  });

  it('keeps a double-colon paragraph as a paragraph when no indented literal block follows', () => {
    const document = ['Note::', '', 'Next paragraph.', ''].join('\n');

    const result = parseRstDocument({ path: 'docs/note.rst', text: document });

    expect(result.spans.find(span => span.kind === 'doc.code_fence')).toBeUndefined();
    expect(result.spans.find(span => span.kind === 'doc.paragraph')).toMatchObject({
      startLine: 1,
      endLine: 1,
      text: 'Note::'
    });
  });
});
