import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  handleNlAnchorCheckpoint,
  handleNlAnchorDemote,
  handleNlAnchorPromote,
  handleNlAnchorRepair,
  handleNlAnchorRetire
} from '../mcp/tools/nl-anchor.js';
import { handleNlStatus } from '../mcp/tools/nl-status.js';
import { createEnvelope, createUnhandledErrorEnvelope, createValidationErrorEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../mcp/envelope.js';
import { serveMcp } from '../mcp/server.js';
import { getHelpText, getStatusHelpText } from './help.js';

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

type AnchorAction = 'status' | 'promote' | 'demote' | 'repair' | 'retire' | 'checkpoint';

const ANCHOR_ACTIONS = new Set<AnchorAction>(['status', 'promote', 'demote', 'repair', 'retire', 'checkpoint']);
const CLI_VERSION = '0.0.0';

function isAnchorAction(value: string | undefined): value is AnchorAction {
  return typeof value === 'string' && ANCHOR_ACTIONS.has(value as AnchorAction);
}

function parsePayloadText(text: string, source: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object payload.`);
  }
  return parsed as Record<string, unknown>;
}

function projectPathFromArgv(argv: string[]): string | undefined {
  const projectIndex = argv.indexOf('--project');
  const value = projectIndex >= 0 ? argv[projectIndex + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function optionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function cliValidationEnvelope(tool: string, projectPath: string | undefined, message: string): NoemaLoomEnvelope {
  return createEnvelope({
    ok: false,
    tool,
    projectRoot: resolveProjectRootFromInput(projectPath ? { projectPath } : {}),
    graphState: 'error',
    warnings: [{ code: 'validation_error', severity: 'error', message }],
    data: { status: 'validation_error', issues: [{ path: '', code: 'invalid_input', message }] },
    nextActions: ['rerun with --help for supported commands and payload shape']
  });
}

async function parseAnchorArgs(argv: string[]): Promise<{ action: AnchorAction; payload: Record<string, unknown> }> {
  const action = argv[1];
  if (!isAnchorAction(action)) {
    throw new Error(`Unknown anchor action: ${action ?? '<missing>'}`);
  }

  let projectPath: string | undefined;
  let jsonText: string | undefined;
  let jsonFile: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      projectPath = optionValue(argv, index, '--project');
      index += 1;
    } else if (arg === '--json') {
      jsonText = optionValue(argv, index, '--json');
      index += 1;
    } else if (arg === '--json-file') {
      jsonFile = optionValue(argv, index, '--json-file');
      index += 1;
    } else {
      throw new Error(`Unknown anchor option: ${arg}`);
    }
  }
  if (jsonText && jsonFile) {
    throw new Error('Use only one of --json or --json-file.');
  }
  if (jsonFile) {
    jsonText = await readFile(jsonFile, 'utf8');
  }
  const payload = jsonText ? parsePayloadText(jsonText, jsonFile ? `--json-file ${jsonFile}` : '--json') : {};
  if (projectPath) payload.projectPath = projectPath;
  return { action, payload };
}

async function runAnchorCommand(argv: string[], io: CliIo): Promise<number> {
  let parsed: { action: AnchorAction; payload: Record<string, unknown> };
  try {
    parsed = await parseAnchorArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stdout.write(`${JSON.stringify(cliValidationEnvelope('noemaloom_anchor_cli', projectPathFromArgv(argv), message), null, 2)}\n`);
    return 1;
  }

  const payload = parsed.payload;
  let result: NoemaLoomEnvelope;
  try {
    result = parsed.action === 'status'
      ? await handleNlStatus({ ...payload, includeAnchors: true })
      : parsed.action === 'promote'
        ? await handleNlAnchorPromote(payload)
        : parsed.action === 'demote'
          ? await handleNlAnchorDemote(payload)
          : parsed.action === 'repair'
            ? await handleNlAnchorRepair(payload)
            : parsed.action === 'retire'
              ? await handleNlAnchorRetire(payload)
              : await handleNlAnchorCheckpoint(payload);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }
    result = createValidationErrorEnvelope(`nl_anchor_${parsed.action}`, resolveProjectRootFromInput(payload), error);
  }

  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

async function parseStatusArgs(argv: string[]): Promise<Record<string, unknown>> {
  let projectPath: string | undefined;
  let jsonText: string | undefined;
  let jsonFile: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      projectPath = optionValue(argv, index, '--project');
      index += 1;
    } else if (arg === '--json') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        jsonText = next;
        index += 1;
      }
    } else if (arg === '--json-file') {
      jsonFile = optionValue(argv, index, '--json-file');
      index += 1;
    } else {
      throw new Error(`Unknown status option: ${arg}`);
    }
  }
  if (jsonText && jsonFile) {
    throw new Error('Use only one of --json JSON or --json-file.');
  }
  if (jsonFile) {
    jsonText = await readFile(jsonFile, 'utf8');
  }
  const payload = jsonText ? parsePayloadText(jsonText, jsonFile ? `--json-file ${jsonFile}` : '--json') : {};
  if (projectPath) payload.projectPath = projectPath;
  return payload;
}

async function runStatusCommand(argv: string[], io: CliIo): Promise<number> {
  let payload: Record<string, unknown>;
  try {
    payload = await parseStatusArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stdout.write(`${JSON.stringify(cliValidationEnvelope('noemaloom_status_cli', projectPathFromArgv(argv), message), null, 2)}\n`);
    return 1;
  }

  let result: NoemaLoomEnvelope;
  try {
    result = await handleNlStatus(payload);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }
    result = createValidationErrorEnvelope('nl_status', resolveProjectRootFromInput(payload), error);
  }
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

export async function runCli(argv = process.argv.slice(2), io = defaultIo): Promise<number> {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    io.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    io.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  if (argv[0] === 'serve') {
    if (!argv.includes('--mcp')) {
      io.stdout.write(`${JSON.stringify(cliValidationEnvelope('noemaloom_cli', projectPathFromArgv(argv), 'serve requires --mcp flag.'), null, 2)}\n`);
      return 1;
    }
    await serveMcp();
    return 0;
  }

  if (argv[0] === 'status') {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout.write(`${getStatusHelpText()}\n`);
      return 0;
    }
    return runStatusCommand(argv, io);
  }

  if (argv[0] === 'anchor') {
    return runAnchorCommand(argv, io);
  }

  io.stdout.write(`${JSON.stringify(cliValidationEnvelope('noemaloom_cli', undefined, `Unknown command: ${argv[0] ?? '<missing>'}`), null, 2)}\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().then(
    exitCode => {
      process.exitCode = exitCode;
    },
    error => {
      process.stdout.write(`${JSON.stringify(createUnhandledErrorEnvelope('noemaloom_cli', process.cwd(), error), null, 2)}\n`);
      process.exitCode = 1;
    }
  );
}
