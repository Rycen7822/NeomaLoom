import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

export const WORKFLOW_NAMES = [
  'repository_locator',
  'markdown_update',
  'code_change_impact',
  'multi_doc_sync',
  'coverage_verification',
  'compression_recovery'
] as const;

const WORKFLOW_INPUT_NAMES = [...WORKFLOW_NAMES, 'all'] as const;
const WORKFLOW_DIR = fileURLToPath(new URL('../../../../../skill/noemaloom/workflows/', import.meta.url));

export const nlSkillInputSchema = z
  .object({
    workflow: z.enum(WORKFLOW_INPUT_NAMES).default('all'),
    format: z.enum(['markdown', 'json']).default('markdown'),
    projectPath: z.string().optional()
  })
  .passthrough();

type WorkflowName = (typeof WORKFLOW_NAMES)[number];

async function readWorkflow(name: WorkflowName): Promise<{ name: WorkflowName; text: string }> {
  return {
    name,
    text: await readFile(path.join(WORKFLOW_DIR, `${name}.md`), 'utf8')
  };
}

export async function handleNlSkill(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlSkillInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const selectedWorkflows =
    parsed.workflow === 'all' ? WORKFLOW_NAMES : ([parsed.workflow] as WorkflowName[]);
  const workflows = await Promise.all(selectedWorkflows.map(readWorkflow));

  if (parsed.format === 'json') {
    return createEnvelope({
      ok: true,
      tool: 'nl_skill',
      projectRoot,
      graphState: 'empty',
      data: {
        workflow: parsed.workflow,
        format: parsed.format,
        workflows
      }
    });
  }

  return createEnvelope({
    ok: true,
    tool: 'nl_skill',
    projectRoot,
    graphState: 'empty',
    data: {
      workflow: parsed.workflow,
      format: parsed.format,
      text: workflows.map(workflow => workflow.text.trim()).join('\n\n---\n\n')
    }
  });
}
