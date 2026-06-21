import path from 'node:path';
import { z } from 'zod';

export type GraphState = 'empty' | 'ready' | 'stale' | 'partial' | 'error';

export type EnvelopeWarning = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
};

export type TokenBudget = {
  requested: number;
  used: number;
  truncated: boolean;
};

export type NoemaLoomEnvelope<TData = Record<string, unknown>> = {
  ok: boolean;
  tool: string;
  projectRoot: string;
  graphRevision: string | null;
  graphState: GraphState;
  tokenBudget: TokenBudget;
  warnings: EnvelopeWarning[];
  data: TData;
  evidence: unknown[];
  nextActions: string[];
};

export type EnvelopeInput<TData> = {
  ok: boolean;
  tool: string;
  projectRoot: string;
  graphState: GraphState;
  data: TData;
  graphRevision?: string | null;
  tokenBudget?: Partial<TokenBudget>;
  warnings?: EnvelopeWarning[];
  evidence?: unknown[];
  nextActions?: string[];
};

export class ProjectRootPolicyError extends Error {
  readonly code = 'project_root_not_allowed';
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(`projectPath is not allowed: ${projectRoot}`);
    this.name = 'ProjectRootPolicyError';
    this.projectRoot = projectRoot;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredAllowedRoots(): string[] {
  return (process.env.NOEMALOOM_ALLOWED_PROJECTS ?? '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
}

function isUnsafeDefaultProjectRoot(projectRoot: string): boolean {
  const resolved = path.resolve(projectRoot);
  if (resolved === path.parse(resolved).root) {
    return true;
  }
  if (process.platform === 'win32') {
    return false;
  }
  const blockedRoots = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr', '/var'];
  return blockedRoots.some(blocked => resolved === blocked || resolved.startsWith(`${blocked}/`));
}

function assertAllowedProjectRoot(projectRoot: string): void {
  const resolved = path.resolve(projectRoot);
  const allowedRoots = configuredAllowedRoots();
  if (allowedRoots.length > 0) {
    if (!allowedRoots.some(allowedRoot => isInsideRoot(allowedRoot, resolved))) {
      throw new ProjectRootPolicyError(resolved);
    }
    return;
  }
  if (isUnsafeDefaultProjectRoot(resolved)) {
    throw new ProjectRootPolicyError(resolved);
  }
}

export function resolveProjectRootFromInput(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'projectPath' in input &&
    typeof input.projectPath === 'string' &&
    input.projectPath !== 'default_current_project'
  ) {
    const resolved = path.resolve(input.projectPath);
    assertAllowedProjectRoot(resolved);
    return resolved;
  }

  return process.cwd();
}

export function createEnvelope<TData>(input: EnvelopeInput<TData>): NoemaLoomEnvelope<TData> {
  return {
    ok: input.ok,
    tool: input.tool,
    projectRoot: path.resolve(input.projectRoot),
    graphRevision: input.graphRevision ?? null,
    graphState: input.graphState,
    tokenBudget: {
      requested: input.tokenBudget?.requested ?? 0,
      used: input.tokenBudget?.used ?? 0,
      truncated: input.tokenBudget?.truncated ?? false
    },
    warnings: input.warnings ?? [],
    data: input.data,
    evidence: input.evidence ?? [],
    nextActions: input.nextActions ?? []
  };
}

function formatErrorMessage(error: unknown, depth = 0): string {
  if (depth > 3) {
    return 'nested error omitted';
  }
  if (error instanceof AggregateError) {
    const nested = error.errors.map((inner, index) => `[${index}] ${formatErrorMessage(inner, depth + 1)}`).join('; ');
    return `${error.name}: ${error.message}${nested ? `; ${nested}` : ''}`;
  }
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause ? `; caused by ${formatErrorMessage(error.cause, depth + 1)}` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

export function createToolUnavailableEnvelope(tool: string, projectRoot = process.cwd()): NoemaLoomEnvelope {
  return createEnvelope({
    ok: false,
    tool,
    projectRoot,
    graphState: 'empty',
    warnings: [
      {
        code: 'tool_not_available',
        severity: 'error',
        message: `${tool} is not exposed by NoemaLoom.`
      }
    ],
    data: {
      status: 'tool_not_available'
    }
  });
}

function validationIssues(error: unknown): Array<{ path: string; code: string; message: string }> {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => ({
      path: issue.path.map(part => String(part)).join('.'),
      code: issue.code,
      message: issue.message
    }));
  }
  return [{ path: '', code: 'invalid_input', message: error instanceof Error ? error.message : String(error) }];
}

export function createValidationErrorEnvelope(
  tool: string,
  projectRoot: string,
  error: unknown
): NoemaLoomEnvelope {
  const issues = validationIssues(error);
  const isInvalidPublicAnchorAction = tool === 'nl_anchor_manage' && issues.some(issue => issue.path === 'action');
  const warningCode = isInvalidPublicAnchorAction ? 'invalid_action' : 'validation_error';
  const message = isInvalidPublicAnchorAction
    ? 'Invalid nl_anchor_manage action. Public Hermes tools support only promote and demote; use the noemaloom anchor repair|retire|checkpoint CLI for low-frequency maintenance.'
    : `Invalid ${tool} input: ${issues.map(issue => issue.path ? `${issue.path}: ${issue.message}` : issue.message).join('; ')}`;

  return createEnvelope({
    ok: false,
    tool,
    projectRoot,
    graphState: 'error',
    warnings: [
      {
        code: warningCode,
        severity: 'error',
        message
      }
    ],
    data: {
      status: 'validation_error',
      issues
    }
  });
}

export function createUnhandledErrorEnvelope(
  tool: string,
  projectRoot: string,
  error: unknown
): NoemaLoomEnvelope {
  return createEnvelope({
    ok: false,
    tool,
    projectRoot,
    graphState: 'error',
    warnings: [
      {
        code: 'handler_error',
        severity: 'error',
        message: formatErrorMessage(error)
      }
    ],
    data: {
      status: 'handler_error'
    }
  });
}
