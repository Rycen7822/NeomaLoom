import { createHash } from 'node:crypto';

import type { FileRole, SpanKind } from '../spans/enums.js';

export type BoundaryRisk = 'low' | 'medium' | 'high';

export type BoundaryValidation = {
  ok: boolean;
  stale: boolean;
  risk: BoundaryRisk;
  warnings: string[];
};

export type BoundaryValidationInput = {
  path: string;
  kind: SpanKind | string;
  role: FileRole | string;
  startLine: number;
  endLine: number;
  indexedFileHash?: string;
  currentText?: string;
  ignored?: boolean;
  generated?: boolean;
  vendor?: boolean;
  includeGeneratedVendor?: boolean;
  evidenceCount?: number;
};

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function lineCount(text: string): number {
  return Math.max(1, text.split(/\r?\n/).length);
}

function hasBrokenFence(lines: string[]): boolean {
  if (lines.length === 0) {
    return false;
  }
  const fenceLines = lines.filter(line => /^\s*```/.test(line)).length;
  return fenceLines % 2 === 1;
}

export function validateBoundary(input: BoundaryValidationInput): BoundaryValidation {
  const warnings: string[] = [];
  const currentLineCount = input.currentText === undefined ? undefined : lineCount(input.currentText);
  const stale =
    input.currentText !== undefined && input.indexedFileHash !== undefined
      ? sha1(input.currentText) !== input.indexedFileHash
      : false;

  if (input.ignored) warnings.push('file ignored');
  if ((input.generated || input.role === 'generated_file') && !input.includeGeneratedVendor) warnings.push('generated file not explicitly requested');
  if ((input.vendor || input.role === 'vendor_file') && !input.includeGeneratedVendor) warnings.push('vendor file not explicitly requested');
  if (input.startLine < 1 || input.endLine < input.startLine) warnings.push('invalid line range');
  if (currentLineCount !== undefined && input.endLine > currentLineCount) warnings.push('line range outside current file');
  if (stale) warnings.push('file content hash differs from index');
  if ((input.evidenceCount ?? 0) === 0) warnings.push('candidate lacks linked evidence');

  if (input.currentText && input.kind === 'doc.code_fence' && input.endLine <= currentLineCount!) {
    const lines = input.currentText.split(/\r?\n/).slice(input.startLine - 1, input.endLine);
    if (hasBrokenFence(lines)) {
      warnings.push('broken markdown code fence boundary');
    }
  }

  const highRisk = warnings.some(warning =>
    [
      'file ignored',
      'generated file not explicitly requested',
      'vendor file not explicitly requested',
      'invalid line range',
      'line range outside current file',
      'broken markdown code fence boundary'
    ].includes(warning)
  );

  return {
    ok: warnings.length === 0 || (warnings.length === 1 && warnings[0] === 'file content hash differs from index'),
    stale,
    risk: highRisk ? 'high' : stale ? 'medium' : 'low',
    warnings
  };
}
