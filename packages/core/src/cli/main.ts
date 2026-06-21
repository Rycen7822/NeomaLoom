import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  handleNlAnchorCheckpoint,
  handleNlAnchorDemote,
  handleNlAnchorPromote,
  handleNlAnchorRepair,
  handleNlAnchorRetire
} from '../mcp/tools/nl-anchor.js';
import { handleNlStatus } from '../mcp/tools/nl-status.js';
import { serveMcp } from '../mcp/server.js';
import { getHelpText } from './help.js';

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
      projectPath = argv[++index];
    } else if (arg === '--json') {
      jsonText = argv[++index];
    } else if (arg === '--json-file') {
      jsonFile = argv[++index];
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
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${getHelpText()}\n`);
    return 1;
  }

  const payload = parsed.payload;
  const result = parsed.action === 'status'
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

  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

export async function runCli(argv = process.argv.slice(2), io = defaultIo): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (argv.length === 2 && argv[0] === 'serve' && argv[1] === '--mcp') {
    await serveMcp();
    return 0;
  }

  if (argv[0] === 'anchor') {
    return runAnchorCommand(argv, io);
  }

  io.stderr.write(`Unknown command.\n\n${getHelpText()}\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().then(
    exitCode => {
      process.exitCode = exitCode;
    },
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
