import { toString } from 'mdast-util-to-string';

import { createGithubSlugger } from './github-slug.js';
import type { DocumentParseResult, DocumentParseWarning, DocumentSpan } from './types.js';

type AstPosition = {
  start?: {
    line?: number;
    column?: number;
  };
  end?: {
    line?: number;
    column?: number;
  };
};

type AstNode = {
  type: string;
  children?: AstNode[];
  position?: AstPosition;
  depth?: number;
  lang?: string | null;
  value?: string;
  url?: string;
};

type HeadingContext = {
  depth: number;
  title: string;
  anchor: string;
  startLine: number;
  headingPath: string[];
};

type BuildOptions = {
  path: string;
  text: string;
  tree: AstNode;
  mdx?: boolean;
};

function startLine(node: AstNode): number | undefined {
  return node.position?.start?.line;
}

function endLine(node: AstNode): number | undefined {
  return node.position?.end?.line;
}

function textForLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function collectInlineCodeMentions(node: AstNode): string[] {
  const mentions = new Set<string>();
  walk(node, child => {
    if (child.type === 'inlineCode' && child.value?.trim()) {
      mentions.add(child.value.trim());
    }
  });
  return [...mentions];
}

function collectImportMentions(value: string): string[] {
  const imports = new Set<string>();
  for (const match of value.matchAll(/\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
    imports.add(match[1]);
  }
  for (const match of value.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.add(match[1]);
  }
  return [...imports];
}

function collectCliMentions(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^noemaloom(?:\s|$)/.test(line));
}

function collectConfigKeyMentions(value: string): string[] {
  const keys = new Set<string>();
  for (const match of value.matchAll(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/gm)) {
    keys.add(match[1]);
  }
  return [...keys];
}

function createSpan(input: {
  kind: DocumentSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  text: string;
  metadata?: Record<string, unknown>;
  anchor?: string;
}): DocumentSpan {
  return {
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine,
    headingPath: input.headingPath,
    anchor: input.anchor,
    text: input.text,
    metadata: input.metadata ?? {}
  };
}

function headingPathAt(headings: HeadingContext[], line: number): string[] {
  let current: HeadingContext[] = [];
  for (const heading of headings) {
    if (heading.startLine > line) {
      break;
    }
    current = current.filter(item => item.depth < heading.depth);
    current.push(heading);
  }
  return current.map(heading => heading.title);
}

function tableMetadata(node: AstNode): Record<string, unknown> {
  const rows = node.children ?? [];
  const normalizedRows = rows
    .map(row => (row.children ?? []).map(cell => toString(cell).trim()).join(' | '))
    .filter(row => row.length > 0);

  return {
    columns: normalizedRows.length > 0 ? normalizedRows[0].split(' | ') : [],
    normalizedTableText: normalizedRows.join('\n')
  };
}

function tableColumns(node: AstNode): string[] {
  const header = node.children?.[0];
  return (header?.children ?? []).map(cell => toString(cell).trim());
}

function tableRowCells(row: AstNode): string[] {
  return (row.children ?? []).map(cell => toString(cell).trim());
}

function buildTableRowSpans(input: {
  node: AstNode;
  path: string;
  lines: string[];
  headingPath: string[];
  tableStartLine: number;
}): DocumentSpan[] {
  const columns = tableColumns(input.node);
  return (input.node.children ?? [])
    .slice(1)
    .map((row, offset) => {
      const cells = tableRowCells(row);
      const normalizedRowText = cells.join(' | ');
      const fallbackLine = input.tableStartLine + offset + 2;
      const start = startLine(row) ?? fallbackLine;
      const end = endLine(row) ?? start;
      return createSpan({
        kind: 'doc.table_row',
        path: input.path,
        label: normalizedRowText || 'table row',
        startLine: start,
        endLine: end,
        headingPath: input.headingPath,
        text: textForLines(input.lines, start, end),
        metadata: {
          columns,
          rowIndex: offset + 1,
          cells,
          normalizedRowText
        }
      });
    })
    .filter(span => String(span.metadata.normalizedRowText ?? '').length > 0);
}

function linkMetadata(url: string): Record<string, unknown> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return {
      targetType: 'external',
      url
    };
  }

  if (url.startsWith('#')) {
    return {
      targetType: 'anchor',
      anchor: url.slice(1)
    };
  }

  const [targetPath, anchor] = url.split('#', 2);
  return {
    targetType: 'relative',
    path: targetPath,
    ...(anchor ? { anchor } : {})
  };
}

function isMdxDegradedNode(node: AstNode): boolean {
  return node.type === 'mdxJsxFlowElement' || node.type === 'mdxFlowExpression';
}

function buildHeadingSpans(input: BuildOptions, lines: string[]): {
  headings: HeadingContext[];
  spans: DocumentSpan[];
} {
  const slugger = createGithubSlugger();
  const headings: HeadingContext[] = [];
  const spans: DocumentSpan[] = [];

  for (const node of input.tree.children ?? []) {
    if (node.type !== 'heading') {
      continue;
    }

    const start = startLine(node);
    const end = endLine(node);
    if (start === undefined || end === undefined) {
      continue;
    }

    const title = toString(node).trim();
    const anchor = slugger.slug(title);
    const depth = node.depth ?? 1;
    const parentPath = headingPathAt(headings, start);
    const headingPath = [...parentPath, title];
    const heading: HeadingContext = {
      depth,
      title,
      anchor,
      startLine: start,
      headingPath
    };
    headings.push(heading);
    spans.push(
      createSpan({
        kind: 'doc.heading',
        path: input.path,
        label: title,
        startLine: start,
        endLine: end,
        headingPath,
        anchor,
        text: textForLines(lines, start, end)
      })
    );
  }

  return { headings, spans };
}

function buildSectionSpans(input: BuildOptions, lines: string[], headings: HeadingContext[]): DocumentSpan[] {
  const spans: DocumentSpan[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    let sectionEnd = lines.length;
    for (const nextHeading of headings.slice(index + 1)) {
      if (nextHeading.depth <= heading.depth) {
        sectionEnd = nextHeading.startLine - 1;
        break;
      }
    }

    while (sectionEnd > heading.startLine && lines[sectionEnd - 1]?.trim() === '') {
      sectionEnd -= 1;
    }

    spans.push(
      createSpan({
        kind: 'doc.section',
        path: input.path,
        label: heading.title,
        startLine: heading.startLine,
        endLine: sectionEnd,
        headingPath: heading.headingPath,
        anchor: heading.anchor,
        text: textForLines(lines, heading.startLine, sectionEnd)
      })
    );
  }

  return spans;
}

function buildBlockSpans(
  input: BuildOptions,
  lines: string[],
  headings: HeadingContext[],
  warnings: DocumentParseWarning[]
): DocumentSpan[] {
  const spans: DocumentSpan[] = [];

  for (const node of input.tree.children ?? []) {
    const start = startLine(node);
    const end = endLine(node);
    if (start === undefined || end === undefined) {
      continue;
    }

    const headingPath = headingPathAt(headings, start);
    const text = textForLines(lines, start, end);
    if (node.type === 'paragraph') {
      spans.push(
        createSpan({
          kind: 'doc.paragraph',
          path: input.path,
          label: toString(node).trim(),
          startLine: start,
          endLine: end,
          headingPath,
          text,
          metadata: {
            inlineCodeMentions: collectInlineCodeMentions(node)
          }
        })
      );
    } else if (node.type === 'list') {
      spans.push(
        createSpan({
          kind: 'doc.list',
          path: input.path,
          label: toString(node).split(/\r?\n/, 1)[0]?.trim() ?? 'list',
          startLine: start,
          endLine: end,
          headingPath,
          text
        })
      );
    } else if (node.type === 'code') {
      const value = node.value ?? '';
      spans.push(
        createSpan({
          kind: 'doc.code_fence',
          path: input.path,
          label: value.split(/\r?\n/, 1)[0]?.trim() ?? 'code',
          startLine: start,
          endLine: end,
          headingPath,
          text,
          metadata: {
            language: node.lang,
            preview: value.split(/\r?\n/, 1)[0] ?? '',
            importMentions: collectImportMentions(value),
            cliMentions: collectCliMentions(value),
            configKeyMentions: collectConfigKeyMentions(value)
          }
        })
      );
    } else if (node.type === 'blockquote') {
      spans.push(
        createSpan({
          kind: 'doc.quote',
          path: input.path,
          label: toString(node).trim(),
          startLine: start,
          endLine: end,
          headingPath,
          text
        })
      );
    } else if (node.type === 'table') {
      spans.push(
        createSpan({
          kind: 'doc.table',
          path: input.path,
          label: 'table',
          startLine: start,
          endLine: end,
          headingPath,
          text,
          metadata: tableMetadata(node)
        })
      );
      spans.push(...buildTableRowSpans({ node, path: input.path, lines, headingPath, tableStartLine: start }));
    } else if (input.mdx && isMdxDegradedNode(node)) {
      warnings.push({
        code: 'mdx_degraded_block',
        severity: 'warning',
        message: `Indexed ${node.type} as a document paragraph span.`,
        startLine: start,
        endLine: end
      });
      spans.push(
        createSpan({
          kind: 'doc.paragraph',
          path: input.path,
          label: text.trim(),
          startLine: start,
          endLine: end,
          headingPath,
          text,
          metadata: {
            mdxDegraded: true,
            mdxNodeType: node.type
          }
        })
      );
    }
  }

  return spans;
}

function buildLinkSpans(input: BuildOptions, lines: string[], headings: HeadingContext[]): DocumentSpan[] {
  const spans: DocumentSpan[] = [];

  walk(input.tree, node => {
    if (node.type !== 'link' || node.url === undefined) {
      return;
    }
    const start = startLine(node);
    const end = endLine(node);
    if (start === undefined || end === undefined) {
      return;
    }
    const label = toString(node).trim();
    spans.push(
      createSpan({
        kind: 'doc.link',
        path: input.path,
        label,
        startLine: start,
        endLine: end,
        headingPath: headingPathAt(headings, start),
        text: textForLines(lines, start, end),
        metadata: linkMetadata(node.url)
      })
    );
  });

  return spans;
}

export function buildDocumentSpans(input: BuildOptions): DocumentParseResult {
  const lines = input.text.split(/\r?\n/);
  const warnings: DocumentParseWarning[] = [];
  const { headings, spans: headingSpans } = buildHeadingSpans(input, lines);

  return {
    path: input.path,
    spans: [
      ...headingSpans,
      ...buildSectionSpans(input, lines, headings),
      ...buildBlockSpans(input, lines, headings, warnings),
      ...buildLinkSpans(input, lines, headings)
    ],
    warnings
  };
}
