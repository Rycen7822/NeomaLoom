import path from 'node:path';

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

export function resolveProjectRootFromInput(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'projectPath' in input &&
    typeof input.projectPath === 'string' &&
    input.projectPath !== 'default_current_project'
  ) {
    return path.resolve(input.projectPath);
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
        message: error instanceof Error ? error.message : String(error)
      }
    ],
    data: {
      status: 'handler_error'
    }
  });
}
