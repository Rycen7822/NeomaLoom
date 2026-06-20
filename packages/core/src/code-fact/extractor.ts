import { createHash } from 'node:crypto';
import path from 'node:path';

import type { EdgeRelation, SpanKind } from '../spans/enums.js';
import { createCodeSpanId } from '../spans/span-id.js';

export type CodeFactSpan = {
  spanId: string;
  kind: Extract<SpanKind, `code.${string}`>;
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  text: string;
  metadata: Record<string, unknown>;
};

export type CodeFactEdge = {
  edgeId: string;
  sourceSpanId: string;
  targetSpanId: string;
  relation: Extract<EdgeRelation, 'contains' | 'calls' | 'imports' | 'extends' | 'implements' | 'references'>;
  sourceLabel: string;
  targetLabel: string;
  confidence: number;
  evidence: Record<string, unknown>;
};

export type ExtractCodeFactsInput = {
  projectRoot: string;
  path: string;
  language: string;
  text: string;
};

export type ExtractCodeFactsResult = {
  spans: CodeFactSpan[];
};

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function textLine(lines: string[], line: number): string {
  return lines[line - 1] ?? '';
}

function moduleLabel(repoPath: string): string {
  return path.posix.basename(repoPath, path.posix.extname(repoPath));
}

function createSpan(input: {
  projectRoot: string;
  kind: CodeFactSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  text: string;
  metadata?: Record<string, unknown>;
}): CodeFactSpan {
  const qualifiedName = String(input.metadata?.qualifiedName ?? `${input.path}:${input.label}`);
  const signature = String(input.metadata?.signature ?? input.label);
  return {
    spanId: createCodeSpanId({
      projectRoot: input.projectRoot,
      path: input.path,
      kind: input.kind,
      qualifiedName,
      signatureHash: sha1(signature)
    }),
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
    startColumn: input.startColumn,
    endColumn: input.endColumn,
    text: input.text,
    metadata: input.metadata ?? {}
  };
}

function signatureForFunction(name: string, params: string, returnType?: string): string {
  return `${name}(${params.trim()})${returnType ? `: ${returnType.trim()}` : ''}`;
}

function extractImportSource(repoPath: string, source: string): string {
  if (!source.startsWith('.')) {
    return source;
  }
  const base = path.posix.dirname(repoPath);
  const joined = path.posix.normalize(path.posix.join(base, source));
  return joined;
}

function importedNamesFromClause(clause: string): string[] {
  const named = clause.match(/\{([^}]+)\}/);
  if (named) {
    return named[1].split(',').map(name => name.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
  }
  const defaultName = clause.trim().split(/\s+/)[0];
  return defaultName ? [defaultName] : [];
}

function addCallsiteSpans(input: {
  projectRoot: string;
  path: string;
  line: string;
  lineNumber: number;
  spans: CodeFactSpan[];
  callerLabel?: string;
  declarationName?: string;
}): void {
  for (const call of input.line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = call[1];
    const zeroBasedColumn = call.index ?? input.line.indexOf(call[0]);
    const startColumn = Math.max(1, zeroBasedColumn + 1);
    const endColumn = startColumn + call[0].length - 1;
    if (
      ['if', 'for', 'while', 'switch', 'function', 'return'].includes(name) ||
      name === input.callerLabel ||
      name === input.declarationName
    ) {
      continue;
    }
    input.spans.push(
      createSpan({
        projectRoot: input.projectRoot,
        kind: 'code.callsite',
        path: input.path,
        label: name,
        startLine: input.lineNumber,
        startColumn,
        endColumn,
        text: input.line,
        metadata: {
          callerLabel: input.callerLabel,
          qualifiedName: `${input.path}:call:${input.lineNumber}:${startColumn}:${name}`,
          signature: `${name}(...)`,
          startColumn,
          endColumn
        }
      })
    );
  }
}

function addJavascriptTypescriptSpans(input: ExtractCodeFactsInput, lines: string[], spans: CodeFactSpan[]): void {
  let currentClass: string | undefined;
  let currentCallable: string | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let declarationName: string | undefined;
    const importMatch = line.match(/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const importedNames = importedNamesFromClause(importMatch[1]);
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.import',
          path: input.path,
          label: importMatch[2],
          startLine: lineNumber,
          text: line,
          metadata: {
            importedNames,
            source: importMatch[2],
            resolvedSource: extractImportSource(input.path, importMatch[2])
          }
        })
      );
    }

    const classMatch = line.match(/^\s*export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_]*))?/);
    if (classMatch) {
      currentClass = classMatch[1];
      currentCallable = undefined;
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.class',
          path: input.path,
          label: classMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${classMatch[1]}`,
            signature: classMatch[1],
            extends: classMatch[2]
          }
        })
      );
      return;
    }

    const functionMatch = line.match(/^\s*export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/);
    if (functionMatch) {
      currentCallable = functionMatch[1];
      declarationName = functionMatch[1];
      const isComponent = /^[A-Z]/.test(functionMatch[1]) && input.path.endsWith('.tsx');
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: isComponent ? 'code.component' : 'code.function',
          path: input.path,
          label: functionMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${functionMatch[1]}`,
            signature: signatureForFunction(functionMatch[1], functionMatch[2], functionMatch[3])
          }
        })
      );
    }

    const methodMatch = currentClass
      ? line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/)
      : undefined;
    if (methodMatch) {
      currentCallable = `${currentClass}.${methodMatch[1]}`;
      declarationName = methodMatch[1];
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.method',
          path: input.path,
          label: methodMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${currentClass}.${methodMatch[1]}`,
            signature: signatureForFunction(methodMatch[1], methodMatch[2], methodMatch[3]),
            className: currentClass
          }
        })
      );
    }

    const constantMatch = line.match(/^\s*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (constantMatch) {
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.constant',
          path: input.path,
          label: constantMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${constantMatch[1]}`,
            signature: constantMatch[1]
          }
        })
      );
    }

    addCallsiteSpans({
      projectRoot: input.projectRoot,
      path: input.path,
      line,
      lineNumber,
      spans,
      callerLabel: currentCallable,
      declarationName
    });
  });
}

type PythonClassFrame = {
  name: string;
  indent: number;
};

function indentation(line: string): number {
  return (line.match(/^[ \t]*/)?.[0] ?? '').replaceAll('\t', '    ').length;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

function countParens(line: string): number {
  return (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
}

function pythonBlockEndLine(lines: string[], declarationIndex: number, signatureEndIndex: number, declarationIndent: number): number {
  let lastContentIndex = signatureEndIndex;
  for (let index = signatureEndIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }
    if (indentation(line) <= declarationIndent) {
      break;
    }
    lastContentIndex = index;
  }
  return Math.max(declarationIndex + 1, lastContentIndex + 1);
}

function pythonSignature(input: { lines: string[]; startIndex: number }): {
  name: string;
  params: string;
  returnType?: string;
  signatureText: string;
  signatureEndIndex: number;
} | undefined {
  const firstLine = input.lines[input.startIndex] ?? '';
  const match = firstLine.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!match) {
    return undefined;
  }
  const collected: string[] = [];
  let balance = 0;
  let signatureEndIndex = input.startIndex;
  for (let index = input.startIndex; index < input.lines.length; index += 1) {
    const line = input.lines[index];
    collected.push(line);
    balance += countParens(line);
    if (balance <= 0 && /:\s*(?:#.*)?$/.test(line)) {
      signatureEndIndex = index;
      break;
    }
  }
  const signatureText = collected.join('\n');
  const firstParen = signatureText.indexOf('(');
  const lastParen = signatureText.lastIndexOf(')');
  const params = firstParen >= 0 && lastParen > firstParen
    ? signatureText.slice(firstParen + 1, lastParen).replace(/\s+/g, ' ').trim()
    : '';
  const returnType = signatureText.match(/\)\s*->\s*([^:]+):/)?.[1]?.trim();
  return {
    name: match[1],
    params,
    returnType,
    signatureText,
    signatureEndIndex
  };
}

function addPythonSpans(input: ExtractCodeFactsInput, lines: string[], spans: CodeFactSpan[]): void {
  const classStack: PythonClassFrame[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!isBlankOrComment(line)) {
      const lineIndent = indentation(line);
      while (classStack.length > 0 && lineIndent <= classStack[classStack.length - 1].indent) {
        classStack.pop();
      }
    }

    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      const classIndent = indentation(classMatch[1]);
      const endLine = pythonBlockEndLine(lines, index, index, classIndent);
      classStack.push({ name: classMatch[2], indent: classIndent });
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.class',
          path: input.path,
          label: classMatch[2],
          startLine: lineNumber,
          endLine,
          text: lines.slice(index, endLine).join('\n'),
          metadata: {
            qualifiedName: `${input.path}:${classMatch[2]}`,
            signature: classMatch[2]
          }
        })
      );
    }

    const signature = pythonSignature({ lines, startIndex: index });
    if (signature) {
      const defIndent = indentation(line);
      const classFrame = [...classStack].reverse().find(frame => defIndent > frame.indent);
      const qualifiedLabel = classFrame ? `${classFrame.name}.${signature.name}` : signature.name;
      const endLine = pythonBlockEndLine(lines, index, signature.signatureEndIndex, defIndent);
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: classFrame ? 'code.method' : 'code.function',
          path: input.path,
          label: signature.name,
          startLine: lineNumber,
          endLine,
          text: lines.slice(index, endLine).join('\n'),
          metadata: {
            qualifiedName: `${input.path}:${qualifiedLabel}`,
            signature: signatureForFunction(signature.name, signature.params, signature.returnType),
            ...(classFrame ? { className: classFrame.name } : {})
          }
        })
      );
    }
  });
}

function addGoSpans(input: ExtractCodeFactsInput, lines: string[], spans: CodeFactSpan[]): void {
  let currentCallable: string | undefined;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const functionMatch = line.match(/^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
    const declarationName = functionMatch?.[1];
    if (functionMatch) {
      currentCallable = functionMatch[1];
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.function',
          path: input.path,
          label: functionMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${functionMatch[1]}`,
            signature: signatureForFunction(functionMatch[1], functionMatch[2])
          }
        })
      );
    }
    addCallsiteSpans({
      projectRoot: input.projectRoot,
      path: input.path,
      line,
      lineNumber,
      spans,
      callerLabel: currentCallable,
      declarationName
    });
  });
}

function addRustSpans(input: ExtractCodeFactsInput, lines: string[], spans: CodeFactSpan[]): void {
  let currentCallable: string | undefined;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const functionMatch = line.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/);
    const declarationName = functionMatch?.[1];
    if (functionMatch) {
      currentCallable = functionMatch[1];
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.function',
          path: input.path,
          label: functionMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${functionMatch[1]}`,
            signature: signatureForFunction(functionMatch[1], functionMatch[2], functionMatch[3])
          }
        })
      );
    }
    addCallsiteSpans({
      projectRoot: input.projectRoot,
      path: input.path,
      line,
      lineNumber,
      spans,
      callerLabel: currentCallable,
      declarationName
    });
  });
}

function addJavaFamilySpans(input: ExtractCodeFactsInput, lines: string[], spans: CodeFactSpan[]): void {
  let currentClass: string | undefined;
  let currentCallable: string | undefined;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const classMatch = line.match(/^\s*(?:public\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      currentClass = classMatch[1];
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: 'code.class',
          path: input.path,
          label: classMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${classMatch[1]}`,
            signature: classMatch[1]
          }
        })
      );
      return;
    }

    const methodMatch = line.match(
      /^\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:void|[A-Za-z0-9_<>,.?]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/
    );
    const declarationName = methodMatch?.[1];
    if (methodMatch) {
      currentCallable = methodMatch[1];
      spans.push(
        createSpan({
          projectRoot: input.projectRoot,
          kind: currentClass ? 'code.method' : 'code.function',
          path: input.path,
          label: methodMatch[1],
          startLine: lineNumber,
          text: line,
          metadata: {
            qualifiedName: `${input.path}:${currentClass ? `${currentClass}.` : ''}${methodMatch[1]}`,
            signature: signatureForFunction(methodMatch[1], methodMatch[2]),
            className: currentClass
          }
        })
      );
    }
    addCallsiteSpans({
      projectRoot: input.projectRoot,
      path: input.path,
      line,
      lineNumber,
      spans,
      callerLabel: currentCallable,
      declarationName
    });
  });
}

export function extractCodeFacts(input: ExtractCodeFactsInput): ExtractCodeFactsResult {
  const lines = input.text.split(/\r?\n/);
  const spans: CodeFactSpan[] = [
    createSpan({
      projectRoot: input.projectRoot,
      kind: 'code.module',
      path: input.path,
      label: moduleLabel(input.path),
      startLine: 1,
      endLine: lines.length,
      text: input.text,
      metadata: {
        qualifiedName: input.path,
        signature: moduleLabel(input.path),
        language: input.language
      }
    })
  ];

  if (input.language === 'typescript' || input.language === 'javascript') {
    addJavascriptTypescriptSpans(input, lines, spans);
  } else if (input.language === 'python') {
    addPythonSpans(input, lines, spans);
  } else if (input.language === 'go') {
    addGoSpans(input, lines, spans);
  } else if (input.language === 'rust') {
    addRustSpans(input, lines, spans);
  } else if (['java', 'kotlin', 'scala'].includes(input.language)) {
    addJavaFamilySpans(input, lines, spans);
  }

  return { spans };
}
