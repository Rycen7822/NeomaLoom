import type { EdgeRelation, FileRole, SpanKind } from './enums.js';
import type { StableLocator } from './stable-locator.js';

export type RepoFile = {
  path: string;
  absolutePath: string;
  role: FileRole;
  language: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: number;
  indexedAt: number;
  generated: boolean;
  ignored: boolean;
  metadata: Record<string, unknown>;
};

export type RepoSpan = {
  spanId: string;
  path: string;
  kind: SpanKind;
  role: FileRole;
  label: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  parentSpanId?: string;
  language: string;
  headingPath: string[];
  symbolPath: string[];
  anchor?: string;
  stableLocator: StableLocator;
  textHash: string;
  indexedText: string;
  summary: string;
  metadata: Record<string, unknown>;
  source: string;
  updatedAt: number;
};

export type RepoEdge = {
  edgeId: string;
  sourceSpanId: string;
  targetSpanId: string;
  relation: EdgeRelation;
  confidence: number;
  source: string;
  evidence: unknown;
  updatedAt: number;
};
