import { z } from 'zod';

export const NOEMALOOM_TOOL_NAMES = [
  'nl_skill',
  'nl_status',
  'nl_refresh',
  'nl_query',
  'nl_locate',
  'nl_context',
  'nl_read_span',
  'nl_trace',
  'nl_impact',
  'nl_verify_coverage'
] as const;

export type NoemaLoomToolName = (typeof NOEMALOOM_TOOL_NAMES)[number];

export type NoemaLoomEnvelope = {
  ok: false;
  tool: NoemaLoomToolName;
  projectRoot: string;
  graphRevision: null;
  graphState: 'empty';
  tokenBudget: {
    requested: 0;
    used: 0;
    truncated: false;
  };
  warnings: Array<{
    code: 'not_implemented';
    severity: 'warning';
    message: string;
  }>;
  data: {
    status: 'not_implemented';
  };
  evidence: [];
  nextActions: [];
};

const placeholderInputSchema = z.object({}).passthrough();

export type NoemaLoomToolDefinition = {
  name: NoemaLoomToolName;
  description: string;
  inputSchema: typeof placeholderInputSchema;
  handler: (args: unknown) => Promise<NoemaLoomEnvelope>;
};

function createNotImplementedEnvelope(tool: NoemaLoomToolName): NoemaLoomEnvelope {
  return {
    ok: false,
    tool,
    projectRoot: process.cwd(),
    graphRevision: null,
    graphState: 'empty',
    tokenBudget: {
      requested: 0,
      used: 0,
      truncated: false
    },
    warnings: [
      {
        code: 'not_implemented',
        severity: 'warning',
        message: `${tool} is registered but not implemented in this phase.`
      }
    ],
    data: {
      status: 'not_implemented'
    },
    evidence: [],
    nextActions: []
  };
}

export function createToolRegistry(): NoemaLoomToolDefinition[] {
  return NOEMALOOM_TOOL_NAMES.map(name => ({
    name,
    description: `${name} placeholder tool.`,
    inputSchema: placeholderInputSchema,
    handler: async () => createNotImplementedEnvelope(name)
  }));
}
