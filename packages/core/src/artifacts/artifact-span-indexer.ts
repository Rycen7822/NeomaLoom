import path from 'node:path';

import { parseJsonArtifact, type ArtifactParseInput, type ArtifactParseResult } from './json-parser.js';
import { parsePackageJsonMetadata, parsePyprojectTomlMetadata } from './package-metadata.js';
import { parseTomlArtifact } from './toml-parser.js';
import { parseYamlArtifact } from './yaml-parser.js';

export function indexArtifactSpans(input: ArtifactParseInput): ArtifactParseResult {
  const basename = path.basename(input.path);
  const extension = path.extname(input.path).toLowerCase();

  if (basename === 'package.json') {
    return parsePackageJsonMetadata(input);
  }
  if (basename === 'pyproject.toml') {
    return parsePyprojectTomlMetadata(input);
  }
  if (extension === '.json') {
    return parseJsonArtifact(input);
  }
  if (extension === '.yaml' || extension === '.yml') {
    return parseYamlArtifact(input);
  }
  if (extension === '.toml') {
    return parseTomlArtifact(input);
  }

  return {
    path: input.path,
    spans: [],
    warnings: [`Unsupported artifact extension: ${extension}`]
  };
}

export type { ArtifactParseInput, ArtifactParseResult, ArtifactSpan } from './json-parser.js';
