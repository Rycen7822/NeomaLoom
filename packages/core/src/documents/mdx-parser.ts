import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { buildDocumentSpans } from './block-spans.js';
import type { DocumentParseResult, ParseDocumentInput } from './types.js';

export function parseMdxDocument(input: ParseDocumentInput): DocumentParseResult {
  const tree = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).parse(input.text);

  return buildDocumentSpans({
    path: input.path,
    text: input.text,
    tree,
    mdx: true
  });
}
