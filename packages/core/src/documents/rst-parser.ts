import type { DocumentParseResult, DocumentSpan, ParseDocumentInput } from './types.js';

const HEADING_MARKS = new Set(['=', '-', '~', '^', '"']);
const HEADING_DEPTHS = new Map([
  ['=', 1],
  ['-', 2],
  ['~', 3],
  ['^', 4],
  ['"', 5]
]);

type RstHeading = {
  depth: number;
  title: string;
  startLine: number;
  headingPath: string[];
};

function textForLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

function isHeadingUnderline(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && new Set(trimmed).size === 1 && HEADING_MARKS.has(trimmed[0]);
}

function headingDepth(value: string): number {
  return HEADING_DEPTHS.get(value.trim()[0]) ?? 1;
}

function headingPathAt(headings: RstHeading[], line: number): string[] {
  let current: RstHeading[] = [];
  for (const heading of headings) {
    if (heading.startLine > line) {
      break;
    }
    current = current.filter(item => item.depth < heading.depth);
    current.push(heading);
  }
  return current.map(heading => heading.title);
}

function collectCliMentions(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^noemaloom(?:\s|$)/.test(line));
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

function createSpan(input: {
  kind: DocumentSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  text: string;
  metadata?: Record<string, unknown>;
}): DocumentSpan {
  return {
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine,
    headingPath: input.headingPath,
    text: input.text,
    metadata: input.metadata ?? {}
  };
}

function appendLinkSpans(input: {
  path: string;
  spans: DocumentSpan[];
  text: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
}): void {
  for (const match of input.text.matchAll(/`([^`<]+?)\s*<([^>]+)>`_/g)) {
    input.spans.push(
      createSpan({
        kind: 'doc.link',
        path: input.path,
        label: match[1].trim(),
        startLine: input.startLine,
        endLine: input.endLine,
        headingPath: input.headingPath,
        text: input.text,
        metadata: linkMetadata(match[2])
      })
    );
  }
}

function appendSectionSpans(input: {
  path: string;
  lines: string[];
  headings: RstHeading[];
  spans: DocumentSpan[];
}): void {
  for (let index = 0; index < input.headings.length; index += 1) {
    const heading = input.headings[index];
    let sectionEnd = input.lines.length;
    for (const nextHeading of input.headings.slice(index + 1)) {
      if (nextHeading.depth <= heading.depth) {
        sectionEnd = nextHeading.startLine - 1;
        break;
      }
    }

    while (sectionEnd > heading.startLine && input.lines[sectionEnd - 1]?.trim() === '') {
      sectionEnd -= 1;
    }

    input.spans.push(
      createSpan({
        kind: 'doc.section',
        path: input.path,
        label: heading.title,
        startLine: heading.startLine,
        endLine: sectionEnd,
        headingPath: heading.headingPath,
        text: textForLines(input.lines, heading.startLine, sectionEnd)
      })
    );
  }
}

export function parseRstDocument(input: ParseDocumentInput): DocumentParseResult {
  const lines = input.text.split(/\r?\n/);
  const spans: DocumentSpan[] = [];
  const headings: RstHeading[] = [];
  let line = 1;

  while (line <= lines.length) {
    const current = lines[line - 1] ?? '';
    const next = lines[line] ?? '';

    if (current.trim() && isHeadingUnderline(next)) {
      const depth = headingDepth(next);
      const parentPath = headingPathAt(headings, line);
      const headingPath = [...parentPath, current.trim()];
      headings.push({
        depth,
        title: current.trim(),
        startLine: line,
        headingPath
      });
      spans.push(
        createSpan({
          kind: 'doc.heading',
          path: input.path,
          label: current.trim(),
          startLine: line,
          endLine: line + 1,
          headingPath,
          text: textForLines(lines, line, line + 1)
        })
      );
      line += 2;
      continue;
    }

    if (!current.trim()) {
      line += 1;
      continue;
    }

    if (current.trim().endsWith('::')) {
      const start = line;
      let probe = line + 1;
      if ((lines[probe - 1] ?? '').trim() === '') {
        probe += 1;
      }
      let hasLiteralLine = false;
      while (probe <= lines.length && /^\s+\S/.test(lines[probe - 1] ?? '')) {
        hasLiteralLine = true;
        probe += 1;
      }
      if (hasLiteralLine) {
        const end = probe - 1;
        spans.push(
          createSpan({
            kind: 'doc.code_fence',
            path: input.path,
            label: current.trim().replace(/::$/, ''),
            startLine: start,
            endLine: end,
            headingPath: headingPathAt(headings, start),
            text: textForLines(lines, start, end),
            metadata: {
              language: 'rst-literal',
              cliMentions: collectCliMentions(textForLines(lines, start, end))
            }
          })
        );
        line = probe;
        continue;
      }
    }

    if (/^[-*+]\s/.test(current.trim())) {
      const start = line;
      while (line <= lines.length && /^[-*+]\s/.test((lines[line - 1] ?? '').trim())) {
        line += 1;
      }
      spans.push(
        createSpan({
          kind: 'doc.list',
          path: input.path,
          label: current.trim(),
          startLine: start,
          endLine: line - 1,
          headingPath: headingPathAt(headings, start),
          text: textForLines(lines, start, line - 1)
        })
      );
      continue;
    }

    const start = line;
    while (
      line <= lines.length &&
      (lines[line - 1] ?? '').trim() &&
      !isHeadingUnderline(lines[line] ?? '') &&
      !/^[-*+]\s/.test((lines[line - 1] ?? '').trim())
    ) {
      line += 1;
    }
    const paragraphText = textForLines(lines, start, line - 1);
    const paragraphHeadingPath = headingPathAt(headings, start);
    spans.push(
      createSpan({
        kind: 'doc.paragraph',
        path: input.path,
        label: current.trim(),
        startLine: start,
        endLine: line - 1,
        headingPath: paragraphHeadingPath,
        text: paragraphText
      })
    );
    appendLinkSpans({
      path: input.path,
      spans,
      text: paragraphText,
      startLine: start,
      endLine: line - 1,
      headingPath: paragraphHeadingPath
    });
  }

  appendSectionSpans({
    path: input.path,
    lines,
    headings,
    spans
  });

  return {
    path: input.path,
    spans,
    warnings: []
  };
}
