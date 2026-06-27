import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from '../state/state-dir.js';
import { createDefaultConfig, type NoemaLoomConfig } from './default-config.js';
import { isErrnoException } from '../shared/fs-errors.js';

export type ConfigValidationError = {
  field: string;
  message: string;
};

export type ConfigLoadResult =
  | {
      ok: true;
      created: boolean;
      config: NoemaLoomConfig;
    }
  | {
      ok: false;
      status: 'config_invalid';
      created: false;
      errors: ConfigValidationError[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArray(value: unknown, field: string, errors: ConfigValidationError[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    errors.push({ field, message: `${field} must be an array of strings` });
  }
}

function validatePositiveInteger(value: unknown, field: string, errors: ConfigValidationError[]): void {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push({ field, message: `${field} must be a positive integer` });
  }
}

function validateBoolean(value: unknown, field: string, errors: ConfigValidationError[]): void {
  if (typeof value !== 'boolean') {
    errors.push({ field, message: `${field} must be a boolean` });
  }
}

function validateString(value: unknown, field: string, errors: ConfigValidationError[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({ field, message: `${field} must be a non-empty string` });
  }
}

function resolvedFeatureStateRoot(projectRoot: string, stateDir: string): string {
  const absolute = path.isAbsolute(stateDir) ? path.resolve(stateDir) : path.resolve(projectRoot, stateDir);
  return path.basename(absolute) === 'planning' ? path.dirname(absolute) : absolute;
}

function isInsideProject(projectRoot: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeConfigWithDefaults(value: unknown, projectRoot: string): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const defaults = createDefaultConfig(projectRoot);
  const normalized: Record<string, unknown> = { ...value };

  if (isRecord(value.fileInventory)) {
    normalized.fileInventory = {
      ...value.fileInventory,
      ignoreGlobs: Array.isArray(value.fileInventory.ignoreGlobs)
        ? uniqueStrings([...defaults.fileInventory.ignoreGlobs, ...value.fileInventory.ignoreGlobs.filter((item): item is string => typeof item === 'string')])
        : value.fileInventory.ignoreGlobs
    };
  }

  if (isRecord(value.featureProjection)) {
    normalized.featureProjection = {
      ...defaults.featureProjection,
      ...value.featureProjection
    };
  }

  return normalized;
}

export function validateConfig(rawValue: unknown, projectRoot: string): ConfigLoadResult {
  const errors: ConfigValidationError[] = [];
  const normalizedValue = normalizeConfigWithDefaults(rawValue, projectRoot);

  if (!isRecord(normalizedValue)) {
    return {
      ok: false,
      status: 'config_invalid',
      created: false,
      errors: [{ field: '$', message: 'config.json must be an object' }]
    };
  }

  const value = normalizedValue;

  if (value.schemaRevision !== 1) {
    errors.push({ field: 'schemaRevision', message: 'schemaRevision must be 1' });
  }

  if (typeof value.projectRoot !== 'string' || !path.isAbsolute(value.projectRoot)) {
    errors.push({ field: 'projectRoot', message: 'projectRoot must be an absolute path' });
  } else if (path.resolve(value.projectRoot) !== path.resolve(projectRoot)) {
    errors.push({ field: 'projectRoot', message: 'projectRoot must match the current project root' });
  }

  const fileInventory = isRecord(value.fileInventory) ? value.fileInventory : undefined;
  if (!fileInventory) {
    errors.push({ field: 'fileInventory', message: 'fileInventory must be an object' });
  } else {
    validateStringArray(fileInventory.includeExtensions, 'fileInventory.includeExtensions', errors);
    validateStringArray(fileInventory.ignoreGlobs, 'fileInventory.ignoreGlobs', errors);
  }

  const indexing = isRecord(value.indexing) ? value.indexing : undefined;
  if (!indexing) {
    errors.push({ field: 'indexing', message: 'indexing must be an object' });
  } else {
    validatePositiveInteger(indexing.maxFileBytes, 'indexing.maxFileBytes', errors);
    validatePositiveInteger(indexing.maxReadSpanLines, 'indexing.maxReadSpanLines', errors);
    validatePositiveInteger(indexing.maxLocatorResults, 'indexing.maxLocatorResults', errors);
    validatePositiveInteger(indexing.maxTraceEdges, 'indexing.maxTraceEdges', errors);
    validatePositiveInteger(indexing.maxToolOutputTokens, 'indexing.maxToolOutputTokens', errors);
  }

  const featureProjection = isRecord(value.featureProjection) ? value.featureProjection : undefined;
  if (!featureProjection) {
    errors.push({ field: 'featureProjection', message: 'featureProjection must be an object' });
  } else {
    validateBoolean(featureProjection.enabled, 'featureProjection.enabled', errors);
    validateString(featureProjection.workerCommand, 'featureProjection.workerCommand', errors);
    validateString(featureProjection.stateDir, 'featureProjection.stateDir', errors);
    if (typeof featureProjection.stateDir === 'string' && featureProjection.stateDir.length > 0) {
      const stateRoot = resolvedFeatureStateRoot(projectRoot, featureProjection.stateDir);
      if (!isInsideProject(projectRoot, stateRoot)) {
        errors.push({ field: 'featureProjection.stateDir', message: 'featureProjection.stateDir must resolve inside the project root' });
      }
    }
    validatePositiveInteger(featureProjection.timeoutMs, 'featureProjection.timeoutMs', errors);
    validatePositiveInteger(featureProjection.maxOutputBytes, 'featureProjection.maxOutputBytes', errors);
  }

  const safety = isRecord(value.safety) ? value.safety : undefined;
  if (!safety) {
    errors.push({ field: 'safety', message: 'safety must be an object' });
  } else {
    validateBoolean(safety.denyRawToolExposure, 'safety.denyRawToolExposure', errors);
    validateBoolean(safety.denyWriter, 'safety.denyWriter', errors);
    validateBoolean(safety.denyGitHooks, 'safety.denyGitHooks', errors);
    validateBoolean(safety.denyExternalVectorDb, 'safety.denyExternalVectorDb', errors);
    validateBoolean(safety.denyAgentConfigWrites, 'safety.denyAgentConfigWrites', errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      status: 'config_invalid',
      created: false,
      errors
    };
  }

  return {
    ok: true,
    created: false,
    config: value as NoemaLoomConfig
  };
}

export async function loadOrCreateConfig(projectRoot: string): Promise<ConfigLoadResult> {
  const paths = await ensureStateDir(projectRoot);

  try {
    const parsed = JSON.parse(await readFile(paths.configFile, 'utf8')) as unknown;
    return validateConfig(parsed, paths.projectRoot);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      const config = createDefaultConfig(paths.projectRoot);
      await writeFileInsideStateDir(paths.projectRoot, paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
      return {
        ok: true,
        created: true,
        config
      };
    }

    if (error instanceof SyntaxError) {
      return {
        ok: false,
        status: 'config_invalid',
        created: false,
        errors: [{ field: '$', message: 'config.json must contain valid JSON' }]
      };
    }

    throw error;
  }
}
