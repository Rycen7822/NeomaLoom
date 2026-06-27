import { extractExampleBlocks } from './example-block-extractor.js';
import { extractTestCases, type TestExampleParseInput, type TestExampleParseResult } from './test-case-extractor.js';

function looksLikeTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(filePath) || /\.(test|spec)\.[A-Za-z0-9]+$/.test(filePath) || /_test\.[A-Za-z0-9]+$/.test(filePath);
}

export function indexTestExampleSpans(input: TestExampleParseInput): TestExampleParseResult {
  const testResult = looksLikeTestPath(input.path) ? extractTestCases(input) : { path: input.path, spans: [], warnings: [] };
  const exampleResult = extractExampleBlocks(input);
  const spans = [
    ...testResult.spans,
    ...exampleResult.spans
  ];

  return {
    path: input.path,
    spans,
    warnings: [...testResult.warnings, ...exampleResult.warnings]
  };
}

export type { TestExampleParseInput, TestExampleParseResult, TestExampleSpan } from './test-case-extractor.js';
