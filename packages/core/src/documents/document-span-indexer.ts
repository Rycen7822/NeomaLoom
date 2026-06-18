import path from 'node:path';

import { appendFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from '../state/state-dir.js';
import { parseMarkdownDocument } from './markdown-parser.js';
import { parseMdxDocument } from './mdx-parser.js';
import { parseRstDocument } from './rst-parser.js';
import type { DocumentParseResult, DocumentParseWarning, ParseDocumentInput } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordParseError(input: ParseDocumentInput, warning: DocumentParseWarning): Promise<void> {
  if (!input.projectRoot) {
    return;
  }

  const paths = await ensureStateDir(input.projectRoot);
  const record = {
    timestamp: new Date().toISOString(),
    path: input.path,
    code: warning.code,
    severity: warning.severity,
    message: warning.message,
    startLine: warning.startLine,
    endLine: warning.endLine
  };
  await appendFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.documentsDir, 'parse-errors.jsonl'),
    `${JSON.stringify(record)}\n`
  );
}

export async function indexDocumentSpans(input: ParseDocumentInput): Promise<DocumentParseResult> {
  const extension = path.extname(input.path).toLowerCase();

  try {
    if (extension === '.mdx') {
      return parseMdxDocument(input);
    }

    if (extension === '.rst') {
      return parseRstDocument(input);
    }

    return parseMarkdownDocument(input);
  } catch (error) {
    const warning: DocumentParseWarning = {
      code: 'document_parse_error',
      severity: 'error',
      message: errorMessage(error)
    };
    await recordParseError(input, warning);
    return {
      path: input.path,
      spans: [],
      warnings: [warning]
    };
  }
}

export type { DocumentParseResult, DocumentParseWarning, DocumentSpan, ParseDocumentInput } from './types.js';
