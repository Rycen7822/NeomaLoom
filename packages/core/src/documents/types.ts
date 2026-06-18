import type { SpanKind } from '../spans/enums.js';

export type DocumentSpanKind = Extract<SpanKind, `doc.${string}`>;

export type DocumentSpan = {
  kind: DocumentSpanKind;
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  anchor?: string;
  text: string;
  metadata: Record<string, unknown>;
};

export type DocumentParseWarning = {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  startLine?: number;
  endLine?: number;
};

export type DocumentParseResult = {
  path: string;
  spans: DocumentSpan[];
  warnings: DocumentParseWarning[];
};

export type ParseDocumentInput = {
  path: string;
  projectRoot?: string;
  text: string;
};
