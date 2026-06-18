import { z } from 'zod';

import {
  createEnvelope,
  createToolUnavailableEnvelope,
  createUnhandledErrorEnvelope,
  resolveProjectRootFromInput,
  type NoemaLoomEnvelope
} from './envelope.js';
import { handleNlSkill, nlSkillInputSchema } from './tools/nl-skill.js';
import { handleNlContext, nlContextInputSchema } from './tools/nl-context.js';
import { handleNlLocate, nlLocateInputSchema } from './tools/nl-locate.js';
import { handleNlQuery, nlQueryInputSchema } from './tools/nl-query.js';
import { handleNlReadSpan, nlReadSpanInputSchema } from './tools/nl-read-span.js';
import { handleNlRefresh, nlRefreshInputSchema } from './tools/nl-refresh.js';
import { handleNlStatus, nlStatusInputSchema } from './tools/nl-status.js';
import { isBlockedToolName } from './validation.js';

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

const placeholderInputSchema = z.object({}).passthrough();

export type NoemaLoomToolDefinition = {
  name: NoemaLoomToolName;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<NoemaLoomEnvelope>;
};

function createNotImplementedEnvelope(tool: NoemaLoomToolName, input: unknown): NoemaLoomEnvelope {
  return createEnvelope({
    ok: false,
    tool,
    graphState: 'empty',
    projectRoot: resolveProjectRootFromInput(input),
    warnings: [
      {
        code: 'not_implemented',
        severity: 'warning',
        message: `${tool} is registered but not implemented in this phase.`
      }
    ],
    data: {
      status: 'not_implemented'
    }
  });
}

function wrapHandler(
  tool: NoemaLoomToolName,
  handler: (args: unknown) => Promise<NoemaLoomEnvelope>
): (args: unknown) => Promise<NoemaLoomEnvelope> {
  return async args => {
    try {
      return await handler(args);
    } catch (error) {
      return createUnhandledErrorEnvelope(tool, resolveProjectRootFromInput(args), error);
    }
  };
}

function createToolDefinition(name: NoemaLoomToolName): NoemaLoomToolDefinition {
  if (name === 'nl_skill') {
    return {
      name,
      description: 'Return packaged NoemaLoom workflow guidance.',
      inputSchema: nlSkillInputSchema,
      handler: wrapHandler(name, handleNlSkill)
    };
  }

  if (name === 'nl_status') {
    return {
      name,
      description: 'Report NoemaLoom state and disabled raw writer surfaces.',
      inputSchema: nlStatusInputSchema,
      handler: wrapHandler(name, handleNlStatus)
    };
  }

  if (name === 'nl_refresh') {
    return {
      name,
      description: 'Refresh NoemaLoom derived repository indexes.',
      inputSchema: nlRefreshInputSchema,
      handler: wrapHandler(name, handleNlRefresh)
    };
  }

  if (name === 'nl_query') {
    return {
      name,
      description: 'Search indexed repository spans without edit decisions.',
      inputSchema: nlQueryInputSchema,
      handler: wrapHandler(name, handleNlQuery)
    };
  }

  if (name === 'nl_locate') {
    return {
      name,
      description: 'Locate repository spans relevant to an edit or verification goal.',
      inputSchema: nlLocateInputSchema,
      handler: wrapHandler(name, handleNlLocate)
    };
  }

  if (name === 'nl_context') {
    return {
      name,
      description: 'Build a compact context package by reusing the locator path.',
      inputSchema: nlContextInputSchema,
      handler: wrapHandler(name, handleNlContext)
    };
  }

  if (name === 'nl_read_span') {
    return {
      name,
      description: 'Read a bounded current-disk span with relocation support.',
      inputSchema: nlReadSpanInputSchema,
      handler: wrapHandler(name, handleNlReadSpan)
    };
  }

  return {
    name,
    description: `${name} placeholder tool.`,
    inputSchema: placeholderInputSchema,
    handler: wrapHandler(name, async args => createNotImplementedEnvelope(name, args))
  };
}

export function createToolRegistry(): NoemaLoomToolDefinition[] {
  return NOEMALOOM_TOOL_NAMES.map(createToolDefinition);
}

export async function callRegisteredTool(toolName: string, args: unknown): Promise<NoemaLoomEnvelope> {
  if (isBlockedToolName(toolName)) {
    return createToolUnavailableEnvelope(toolName, resolveProjectRootFromInput(args));
  }

  const tool = createToolRegistry().find(candidate => candidate.name === toolName);

  if (!tool) {
    return createToolUnavailableEnvelope(toolName, resolveProjectRootFromInput(args));
  }

  return tool.handler(args);
}
