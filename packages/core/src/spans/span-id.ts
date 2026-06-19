import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SpanKind } from './enums.js';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function root(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export function createCodeSpanId(input: {
  projectRoot: string;
  path: string;
  kind: SpanKind;
  qualifiedName: string;
  signatureHash: string;
}): string {
  return `code:${sha1(`${root(input.projectRoot)}${input.path}${input.kind}${input.qualifiedName}${input.signatureHash}`)}`;
}

export function createDocumentSpanId(input: {
  projectRoot: string;
  path: string;
  headingPath: string[];
  kind: SpanKind;
  blockOrdinal: number;
  normalizedTextHash: string;
}): string {
  return `doc:${sha1(
    `${root(input.projectRoot)}${input.path}${JSON.stringify(input.headingPath)}${input.kind}${input.blockOrdinal}${input.normalizedTextHash}`
  )}`;
}

export function createConfigSpanId(input: {
  projectRoot: string;
  path: string;
  jsonPointerOrTomlPath: string;
  normalizedValueHash: string;
}): string {
  return `config:${sha1(`${root(input.projectRoot)}${input.path}${input.jsonPointerOrTomlPath}${input.normalizedValueHash}`)}`;
}

export function createTestExampleSpanId(input: {
  projectRoot: string;
  path: string;
  kind: Extract<SpanKind, `test.${string}` | `example.${string}`>;
  testOrExampleName: string;
  normalizedTextHash: string;
  startLine?: number;
}): string {
  return `tx:${sha1(
    `${root(input.projectRoot)}${input.path}${input.kind}${input.testOrExampleName}${input.normalizedTextHash}${input.startLine ?? ''}`
  )}`;
}

export function createFeatureSpanId(input: {
  projectRoot: string;
  featurePath: string;
  featureLabel: string;
  sourceId: string;
}): string {
  return `feature:${sha1(`${root(input.projectRoot)}${input.featurePath}${input.featureLabel}${input.sourceId}`)}`;
}
