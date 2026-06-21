import { spawn } from 'node:child_process';
import path from 'node:path';

export type FeatureWorkerCommand =
  | 'feature.status'
  | 'feature.import_existing'
  | 'feature.project_from_repo'
  | 'feature.update_changed'
  | 'feature.query'
  | 'feature.explore'
  | 'feature.detail'
  | 'feature.tree';

export type FeatureWorkerResult = {
  state: 'available' | 'unavailable';
  data?: unknown;
  warnings: string[];
};

const DEFAULT_WORKER_ARGS = ['-m', 'nl_rpg_projection_worker.main'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const FORCE_KILL_GRACE_MS = 2_000;

function parseWorkerCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (quote) {
    throw new Error('featureProjection.workerCommand contains an unterminated quote');
  }
  if (current) parts.push(current);
  return parts;
}

function commandParts(input: { workerCommand?: string; pythonExecutable?: string }): { executable: string; args: string[] } {
  if (input.workerCommand?.trim()) {
    const parts = parseWorkerCommand(input.workerCommand);
    if (parts.length === 0) {
      throw new Error('featureProjection.workerCommand must not be empty');
    }
    const [executable, ...args] = parts;
    return { executable, args };
  }
  return { executable: input.pythonExecutable ?? 'python3', args: [...DEFAULT_WORKER_ARGS] };
}

export async function runFeatureWorkerCommand(input: {
  command: FeatureWorkerCommand;
  projectRoot: string;
  stateDir: string;
  revision: string;
  payload?: Record<string, unknown>;
  pythonExecutable?: string;
  pythonPath?: string;
  workerCommand?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<FeatureWorkerResult> {
  let command;
  try {
    command = commandParts(input);
  } catch (error) {
    return { state: 'unavailable', warnings: [error instanceof Error ? error.message : String(error)] };
  }
  const pythonPath = input.pythonPath
    ? [input.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    : process.env.PYTHONPATH;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxOutputBytes = Math.max(1, Math.floor(input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));

  return new Promise(resolve => {
    let settled = false;
    let terminating = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: FeatureWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (!terminating && forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    const child = spawn(command.executable, command.args, {
      env: {
        ...process.env,
        NOEMALOOM_PROJECT_ROOT: input.projectRoot,
        NOEMALOOM_STATE_DIR: input.stateDir,
        NOEMALOOM_GRAPH_REVISION: input.revision,
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeoutTimer = setTimeout(() => {
      terminating = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_GRACE_MS);
      settle({ state: 'unavailable', warnings: [`Worker timed out after ${timeoutMs}ms.`] });
    }, timeoutMs);

    const appendOutput = (stream: 'stdout' | 'stderr', chunk: unknown): void => {
      if (settled) return;
      const text = String(chunk);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxOutputBytes) {
        terminating = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_GRACE_MS);
        settle({
          state: 'unavailable',
          warnings: [`Worker output exceeded maxOutputBytes=${maxOutputBytes}.`]
        });
      }
    };

    child.stdout.on('data', chunk => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', chunk => {
      appendOutput('stderr', chunk);
    });
    child.stdin.on('error', () => {
      // The worker may exit before consuming stdin (for example malformed-output probes).
      // The close handler reports the actual worker result; avoid surfacing EPIPE as an unhandled process error.
    });
    child.on('error', error => {
      settle({ state: 'unavailable', warnings: [error.message] });
    });
    child.on('close', code => {
      if (terminating) {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        return;
      }
      if (code !== 0) {
        settle({ state: 'unavailable', warnings: [stderr || `Worker exited with code ${code}`] });
        return;
      }
      const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
      if (!firstLine) {
        settle({ state: 'unavailable', warnings: ['Worker produced no response.'] });
        return;
      }
      let response: { ok: boolean; data?: unknown; error?: { message?: string } };
      try {
        response = JSON.parse(firstLine) as { ok: boolean; data?: unknown; error?: { message?: string } };
      } catch (error) {
        settle({ state: 'unavailable', warnings: [error instanceof Error ? error.message : 'Invalid worker response.'] });
        return;
      }
      if (!response.ok) {
        settle({ state: 'unavailable', data: response.data, warnings: [response.error?.message ?? 'Worker command failed.'] });
        return;
      }
      settle({ state: 'available', data: response.data, warnings: [] });
    });
    child.stdin.end(`${JSON.stringify({ command: input.command, payload: input.payload ?? {} })}\n`);
  });
}
