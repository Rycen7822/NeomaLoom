import { createArtifactSpan, parseJsonArtifact, type ArtifactParseInput, type ArtifactParseResult, type ArtifactSpan } from './json-parser.js';
import { parseTomlArtifact } from './toml-parser.js';

const MAX_PACKAGE_EXPORT_DEPTH = 50;

function lineFor(lines: string[], needle: string): number {
  const index = lines.findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

function packageEntry(input: {
  path: string;
  lines: string[];
  label: string;
  metadata: Record<string, unknown>;
}): ArtifactSpan {
  const line = lineFor(input.lines, JSON.stringify(input.label));
  return createArtifactSpan({
    kind: 'config.entry',
    path: input.path,
    label: input.label,
    startLine: line,
    text: input.lines[line - 1] ?? '',
    metadata: input.metadata
  });
}

function appendExportEntrypoints(input: {
  spans: ArtifactSpan[];
  path: string;
  lines: string[];
  value: unknown;
  exportPath: string;
  depth?: number;
}): void {
  const depth = input.depth ?? 0;
  if (depth > MAX_PACKAGE_EXPORT_DEPTH) {
    return;
  }
  if (typeof input.value === 'string') {
    input.spans.push(
      packageEntry({
        path: input.path,
        lines: input.lines,
        label: input.value,
        metadata: {
          packageEntrypoint: input.exportPath
        }
      })
    );
    return;
  }

  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) {
    return;
  }

  for (const [key, child] of Object.entries(input.value)) {
    appendExportEntrypoints({
      ...input,
      value: child,
      exportPath: key.startsWith('.') ? `${input.exportPath}${key}` : `${input.exportPath}.${key}`,
      depth: depth + 1
    });
  }
}

export function parsePackageJsonMetadata(input: ArtifactParseInput): ArtifactParseResult {
  const base = parseJsonArtifact(input);
  if (base.warnings.length > 0) {
    return base;
  }

  const lines = input.text.split(/\r?\n/);
  const value = JSON.parse(input.text) as {
    scripts?: Record<string, string>;
    main?: string;
    module?: string;
    types?: string;
    exports?: unknown;
    bin?: string | Record<string, string>;
    workspaces?: string[] | { packages?: string[] };
  };
  const spans = [...base.spans];

  for (const script of Object.keys(value.scripts ?? {})) {
    spans.push(
      packageEntry({
        path: input.path,
        lines,
        label: script,
        metadata: {
          packageScript: script
        }
      })
    );
  }

  for (const key of ['main', 'module', 'types'] as const) {
    if (typeof value[key] === 'string') {
      spans.push(
        packageEntry({
          path: input.path,
          lines,
          label: value[key],
          metadata: {
            packageEntrypoint: key
          }
        })
      );
    }
  }

  appendExportEntrypoints({
    spans,
    path: input.path,
    lines,
    value: value.exports,
    exportPath: 'exports'
  });

  if (typeof value.bin === 'string') {
    spans.push(
      packageEntry({
        path: input.path,
        lines,
        label: value.bin,
        metadata: {
          packageEntrypoint: 'bin'
        }
      })
    );
  } else {
    for (const [name, target] of Object.entries(value.bin ?? {})) {
      spans.push(
        packageEntry({
          path: input.path,
          lines,
          label: target,
          metadata: {
            packageEntrypoint: `bin.${name}`
          }
        })
      );
    }
  }

  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : value.workspaces?.packages ?? [];
  for (const workspace of workspaces) {
    spans.push(
      packageEntry({
        path: input.path,
        lines,
        label: workspace,
        metadata: {
          workspacePackageName: workspace
        }
      })
    );
  }

  return {
    path: input.path,
    spans,
    warnings: []
  };
}

function cleanTomlString(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

export function parsePyprojectTomlMetadata(input: ArtifactParseInput): ArtifactParseResult {
  const base = parseTomlArtifact(input);
  const lines = input.text.split(/\r?\n/);
  const spans = [...base.spans];
  let tablePath = '';

  lines.forEach((line, index) => {
    const table = line.trim().match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (table) {
      tablePath = table[1];
      return;
    }

    const entry = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!entry || (tablePath !== 'project.scripts' && tablePath !== 'tool.poetry.scripts')) {
      return;
    }

    const scriptName = entry[1];
    const target = cleanTomlString(entry[2]);
    spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: scriptName,
        startLine: index + 1,
        text: line,
        metadata: {
          tomlPath: `${tablePath}.${scriptName}`,
          packageScript: scriptName
        }
      }),
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: target,
        startLine: index + 1,
        text: line,
        metadata: {
          tomlPath: `${tablePath}.${scriptName}`,
          packageEntrypoint: `${tablePath}.${scriptName}`
        }
      })
    );
  });

  return {
    path: input.path,
    spans,
    warnings: base.warnings
  };
}
