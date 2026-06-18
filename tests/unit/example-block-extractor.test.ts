import { extractExampleBlocks } from '../../packages/core/src/tests-examples/example-block-extractor.js';

describe('example block extractor', () => {
  it('classifies examples directory files as example files and blocks', () => {
    const result = extractExampleBlocks({
      path: 'examples/hello.ts',
      text: ["import { createClient } from '../src/client';", 'createClient();', ''].join('\n')
    });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'example.file',
          label: 'hello.ts',
          startLine: 1
        }),
        expect.objectContaining({
          kind: 'example.block',
          label: 'hello.ts',
          metadata: expect.objectContaining({
            source: 'examples_path',
            language: 'ts'
          })
        })
      ])
    );
  });

  it('extracts executable README quickstart and tutorial fenced code blocks', () => {
    const readme = extractExampleBlocks({
      path: 'README.md',
      text: ['# Project', '', '## Quickstart', '', '```bash', 'noemaloom --help', '```', ''].join('\n')
    });
    const tutorial = extractExampleBlocks({
      path: 'docs/tutorial/setup.md',
      text: ['# Setup', '', '```python', 'print("hello")', '```', ''].join('\n')
    });

    expect(readme.spans).toEqual([
      expect.objectContaining({
        kind: 'example.block',
        startLine: 5,
        endLine: 7,
        metadata: expect.objectContaining({
          source: 'readme_quickstart',
          language: 'bash'
        })
      })
    ]);
    expect(tutorial.spans).toEqual([
      expect.objectContaining({
        kind: 'example.block',
        startLine: 3,
        endLine: 5,
        metadata: expect.objectContaining({
          source: 'tutorial_markdown',
          language: 'python'
        })
      })
    ]);
  });
});
