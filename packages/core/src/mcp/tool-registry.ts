import { z } from 'zod';

import {
  createEnvelope,
  createToolUnavailableEnvelope,
  createUnhandledErrorEnvelope,
  resolveProjectRootFromInput,
  type NoemaLoomEnvelope
} from './envelope.js';
import { handleNlContext, nlContextInputSchema } from './tools/nl-context.js';
import { handleNlImpact, nlImpactInputSchema } from './tools/nl-impact.js';
import { handleNlLocate, nlLocateInputSchema } from './tools/nl-locate.js';
import { handleNlPlanChange, nlPlanChangeInputSchema } from './tools/nl-plan-change.js';
import { handleNlPrepareContext, nlPrepareContextInputSchema } from './tools/nl-prepare-context.js';
import { handleNlQuery, nlQueryInputSchema } from './tools/nl-query.js';
import { handleNlReadSpan, nlReadSpanInputSchema } from './tools/nl-read-span.js';
import { handleNlRefresh, nlRefreshInputSchema } from './tools/nl-refresh.js';
import { handleNlStatus, nlStatusInputSchema } from './tools/nl-status.js';
import { handleNlTrace, nlTraceInputSchema } from './tools/nl-trace.js';
import { handleNlVerifyTask, nlVerifyTaskInputSchema } from './tools/nl-verify-task.js';
import { handleNlVerifyCoverage, nlVerifyCoverageInputSchema } from './tools/nl-verify-coverage.js';
import { isBlockedToolName } from './validation.js';
import {
  handleNlAnchorCheckpoint,
  handleNlAnchorDemote,
  handleNlAnchorPromote,
  handleNlAnchorRepair,
  handleNlAnchorRetire,
  handleNlAnchorStatus,
  nlAnchorCheckpointInputSchema,
  nlAnchorDemoteInputSchema,
  nlAnchorPromoteInputSchema,
  nlAnchorRepairInputSchema,
  nlAnchorRetireInputSchema,
  nlAnchorStatusInputSchema
} from './tools/nl-anchor.js';

export const NOEMALOOM_TOOL_NAMES = [
  'nl_status',
  'nl_refresh',
  'nl_prepare_context',
  'nl_plan_change',
  'nl_verify_task',
  'nl_anchor_status',
  'nl_anchor_promote',
  'nl_anchor_demote',
  'nl_anchor_repair',
  'nl_anchor_retire',
  'nl_anchor_checkpoint'
] as const;

export const NOEMALOOM_HIDDEN_TOOL_NAMES = [
  'nl_query',
  'nl_locate',
  'nl_context',
  'nl_read_span',
  'nl_trace',
  'nl_impact',
  'nl_verify_coverage'
] as const;

export type NoemaLoomToolName =
  | (typeof NOEMALOOM_TOOL_NAMES)[number]
  | (typeof NOEMALOOM_HIDDEN_TOOL_NAMES)[number];

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

  if (name === 'nl_prepare_context') {
    return {
      name,
      description: 'Prepare compact task context by combining query preview, locating, context assembly, and optional top-span reads.',
      inputSchema: nlPrepareContextInputSchema,
      handler: wrapHandler(name, handleNlPrepareContext)
    };
  }

  if (name === 'nl_plan_change') {
    return {
      name,
      description: 'Plan change impact by combining locating, trace, and grouped impact analysis.',
      inputSchema: nlPlanChangeInputSchema,
      handler: wrapHandler(name, handleNlPlanChange)
    };
  }

  if (name === 'nl_verify_task') {
    return {
      name,
      description: 'Verify an edited task with coverage checks and optional impact context.',
      inputSchema: nlVerifyTaskInputSchema,
      handler: wrapHandler(name, handleNlVerifyTask)
    };
  }

  if (name === 'nl_anchor_status') {
    return {
      name,
      description: 'Inspect project-local NoemaLoom navigation anchors and lifecycle counters.',
      inputSchema: nlAnchorStatusInputSchema,
      handler: wrapHandler(name, handleNlAnchorStatus)
    };
  }

  if (name === 'nl_anchor_promote') {
    return {
      name,
      description: 'Promote a path or span into the project-local navigation anchor pool through a controlled curation operation.',
      inputSchema: nlAnchorPromoteInputSchema,
      handler: wrapHandler(name, handleNlAnchorPromote)
    };
  }

  if (name === 'nl_anchor_demote') {
    return {
      name,
      description: 'Demote an existing navigation anchor to dormant or archived using activity-count lifecycle state.',
      inputSchema: nlAnchorDemoteInputSchema,
      handler: wrapHandler(name, handleNlAnchorDemote)
    };
  }

  if (name === 'nl_anchor_repair') {
    return {
      name,
      description: 'Repair an existing navigation anchor path, label, kind, role, or line range without raw JSON edits.',
      inputSchema: nlAnchorRepairInputSchema,
      handler: wrapHandler(name, handleNlAnchorRepair)
    };
  }

  if (name === 'nl_anchor_retire') {
    return {
      name,
      description: 'Retire an obsolete navigation anchor and write a tombstone so future locator hits do not revive it.',
      inputSchema: nlAnchorRetireInputSchema,
      handler: wrapHandler(name, handleNlAnchorRetire)
    };
  }

  if (name === 'nl_anchor_checkpoint') {
    return {
      name,
      description: 'Update project-local navigation-anchor checkpoint metadata such as opt-in enablement.',
      inputSchema: nlAnchorCheckpointInputSchema,
      handler: wrapHandler(name, handleNlAnchorCheckpoint)
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

  if (name === 'nl_trace') {
    return {
      name,
      description: 'Trace indexed cross-surface span relations.',
      inputSchema: nlTraceInputSchema,
      handler: wrapHandler(name, handleNlTrace)
    };
  }

  if (name === 'nl_impact') {
    return {
      name,
      description: 'Group trace results into code, docs, config, tests, examples, and features.',
      inputSchema: nlImpactInputSchema,
      handler: wrapHandler(name, handleNlImpact)
    };
  }

  if (name === 'nl_verify_coverage') {
    return {
      name,
      description: 'Verify changed files for old terms, links, anchors, and coverage gaps.',
      inputSchema: nlVerifyCoverageInputSchema,
      handler: wrapHandler(name, handleNlVerifyCoverage)
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

export function createInternalToolRegistry(): NoemaLoomToolDefinition[] {
  return [...NOEMALOOM_TOOL_NAMES, ...NOEMALOOM_HIDDEN_TOOL_NAMES].map(createToolDefinition);
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

export async function callInternalTool(toolName: string, args: unknown): Promise<NoemaLoomEnvelope> {
  if (isBlockedToolName(toolName)) {
    return createToolUnavailableEnvelope(toolName, resolveProjectRootFromInput(args));
  }

  const tool = createInternalToolRegistry().find(candidate => candidate.name === toolName);

  if (!tool) {
    return createToolUnavailableEnvelope(toolName, resolveProjectRootFromInput(args));
  }

  return tool.handler(args);
}
