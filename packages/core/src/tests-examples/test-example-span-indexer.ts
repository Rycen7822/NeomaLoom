import { extractExampleBlocks } from './example-block-extractor.js';
import { extractTestCases, type TestExampleParseInput, type TestExampleParseResult } from './test-case-extractor.js';

function looksLikeTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(filePath) || /\.(test|spec)\.[A-Za-z0-9]+$/.test(filePath) || /_test\.[A-Za-z0-9]+$/.test(filePath);
}

export function indexTestExampleSpans(input: TestExampleParseInput): TestExampleParseResult {
  const spans = [
    ...(looksLikeTestPath(input.path) ? extractTestCases(input).spans : []),
    ...extractExampleBlocks(input).spans
  ];

  return {
    path: input.path,
    spans,
    warnings: []
  };
}

export type { TestExampleParseInput, TestExampleParseResult, TestExampleSpan } from './test-case-extractor.js';
