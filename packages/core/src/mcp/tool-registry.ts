import { z } from 'zod';

import {
  createEnvelope,
  createToolUnavailableEnvelope,
  createUnhandledErrorEnvelope,
  resolveProjectRootFromInput,
  type NoemaLoomEnvelope
} from './envelope.js';
import { handleNlSkill, nlSkillInputSchema } from './tools/nl-skill.js';
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
  inputSchema: typeof placeholderInputSchema;
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
