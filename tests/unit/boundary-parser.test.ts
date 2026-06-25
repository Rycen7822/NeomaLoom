import { detectFallbackBoundary, detectTypescriptBlockBoundary, wrapPythonBlockBoundary } from '../../packages/core/src/code-fact/boundary-parser.js';

describe('code fact block boundary parser', () => {
  it('detects TypeScript function and class block ends while ignoring braces in strings and comments', () => {
    const lines = [
      'export function runTask(task: Task) {',
      '  const object = { value: "}" };',
      '  // comment with }',
      '  const pattern = /a{2,4}/;',
      '  return `${object.value}`;',
      '}',
      'export class Scheduler {',
      '  schedule(task: Task) {',
      '    return runTask(task);',
      '  }',
      '}'
    ];

    expect(detectTypescriptBlockBoundary({ lines, declarationLineIndex: 0, filePath: 'src/scheduler.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: true,
      reason: 'balanced_braces',
      endLine: 6
    });
    expect(detectTypescriptBlockBoundary({ lines, declarationLineIndex: 6, filePath: 'src/scheduler.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: true,
      reason: 'balanced_braces',
      endLine: 11
    });
  });

  it('carries TypeScript lexical state across multiline comments and template strings', () => {
    const blockComment = [
      'export function withComment() {',
      '  /*',
      '   * } this brace is documentation, not code',
      '   */',
      '  return 1;',
      '}'
    ];
    const templateString = [
      'export function withTemplate() {',
      '  const text = `',
      '    } this brace is text, not code',
      '  `;',
      '  return text;',
      '}'
    ];

    expect(detectTypescriptBlockBoundary({ lines: blockComment, declarationLineIndex: 0, filePath: 'src/comment.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: true,
      reason: 'balanced_braces',
      endLine: 6
    });
    expect(detectTypescriptBlockBoundary({ lines: templateString, declarationLineIndex: 0, filePath: 'src/template.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: true,
      reason: 'balanced_braces',
      endLine: 6
    });
  });

  it('returns incomplete boundaries for unbalanced or missing braces and wraps non-TS boundaries', () => {
    expect(detectTypescriptBlockBoundary({ lines: ['export function broken() {', '  if (true) {'], declarationLineIndex: 0, filePath: 'src/broken.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: false,
      reason: 'unbalanced_braces',
      endLine: 2
    });
    expect(detectTypescriptBlockBoundary({ lines: ['export const value = 1;', 'const x = 2;'], declarationLineIndex: 0, filePath: 'src/value.ts' })).toMatchObject({
      method: 'typescript_brace',
      complete: false,
      reason: 'opening_brace_not_found'
    });
    expect(wrapPythonBlockBoundary({ endLine: 12 })).toEqual({
      method: 'python_indent',
      complete: true,
      reason: 'indentation',
      endLine: 12
    });
    expect(detectFallbackBoundary({ declarationLineIndex: 4, reason: 'language_not_supported_for_full_boundary' })).toEqual({
      method: 'fallback_line',
      complete: false,
      reason: 'language_not_supported_for_full_boundary',
      endLine: 5
    });
  });
});
