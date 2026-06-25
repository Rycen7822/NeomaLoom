export type CodeBoundaryMethod = 'typescript_brace' | 'python_indent' | 'fallback_line';

export type CodeBoundary = {
  method: CodeBoundaryMethod;
  complete: boolean;
  reason: string;
  endLine: number;
};

export function detectFallbackBoundary(input: { declarationLineIndex: number; reason: string }): CodeBoundary {
  return {
    method: 'fallback_line',
    complete: false,
    reason: input.reason,
    endLine: input.declarationLineIndex + 1
  };
}

export function wrapPythonBlockBoundary(input: { endLine: number }): CodeBoundary {
  return {
    method: 'python_indent',
    complete: true,
    reason: 'indentation',
    endLine: input.endLine
  };
}

function isRegexStart(previous: string): boolean {
  const trimmed = previous.trimEnd();
  if (trimmed.length === 0) return true;
  return /[=(:,!&|?{};\[]$/.test(trimmed) || /\b(?:return|case|throw|typeof|instanceof|delete|void|new)$/.test(trimmed);
}

type BraceSyntaxState = {
  quote?: 'template';
  escaped: boolean;
  inBlockComment: boolean;
};

function braceDeltaOutsideSyntax(line: string, state: BraceSyntaxState): { delta: number; sawOpeningBrace: boolean } {
  let delta = 0;
  let sawOpeningBrace = false;
  let quote: 'single' | 'double' | 'template' | 'regex' | undefined = state.quote;
  let escaped = state.escaped;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (state.inBlockComment) {
      const close = line.indexOf('*/', index);
      if (close < 0) {
        return { delta, sawOpeningBrace };
      }
      state.inBlockComment = false;
      index = close + 1;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (quote === 'single' && char === "'") quote = undefined;
      else if (quote === 'double' && char === '"') quote = undefined;
      else if (quote === 'template' && char === '`') quote = undefined;
      else if (quote === 'regex' && char === '/') quote = undefined;
      continue;
    }

    if (char === '/' && next === '/') {
      break;
    }
    if (char === '/' && next === '*') {
      const close = line.indexOf('*/', index + 2);
      if (close < 0) {
        state.inBlockComment = true;
        break;
      }
      index = close + 1;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      escaped = false;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      escaped = false;
      continue;
    }
    if (char === '`') {
      quote = 'template';
      escaped = false;
      continue;
    }
    if (char === '/' && next !== '/' && next !== '*' && line.length <= 4096 && isRegexStart(line.slice(0, index))) {
      quote = 'regex';
      escaped = false;
      continue;
    }
    if (char === '{') {
      delta += 1;
      sawOpeningBrace = true;
    } else if (char === '}') {
      delta -= 1;
    }
  }

  state.quote = quote === 'template' ? 'template' : undefined;
  state.escaped = quote === 'template' ? escaped : false;
  return { delta, sawOpeningBrace };
}

export function detectTypescriptBlockBoundary(input: {
  lines: string[];
  declarationLineIndex: number;
  filePath: string;
}): CodeBoundary {
  const declaration = input.lines[input.declarationLineIndex];
  if (declaration === undefined) {
    return detectFallbackBoundary({ declarationLineIndex: input.declarationLineIndex, reason: 'declaration_line_missing' });
  }

  let depth = 0;
  let sawOpeningBrace = false;
  const syntaxState: BraceSyntaxState = { escaped: false, inBlockComment: false };
  for (let index = input.declarationLineIndex; index < input.lines.length; index += 1) {
    const { delta, sawOpeningBrace: lineSawOpeningBrace } = braceDeltaOutsideSyntax(input.lines[index], syntaxState);
    if (lineSawOpeningBrace) {
      sawOpeningBrace = true;
    }
    depth += delta;
    if (sawOpeningBrace && depth <= 0) {
      return {
        method: 'typescript_brace',
        complete: true,
        reason: 'balanced_braces',
        endLine: index + 1
      };
    }
  }

  return {
    method: 'typescript_brace',
    complete: false,
    reason: sawOpeningBrace ? 'unbalanced_braces' : 'opening_brace_not_found',
    endLine: input.lines.length
  };
}
