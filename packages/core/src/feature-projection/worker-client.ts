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

export async function runFeatureWorkerCommand(input: {
  command: FeatureWorkerCommand;
  projectRoot: string;
  stateDir: string;
  revision: string;
  payload?: Record<string, unknown>;
  pythonExecutable?: string;
  pythonPath?: string;
}): Promise<FeatureWorkerResult> {
  const executable = input.pythonExecutable ?? 'python3';
  const pythonPath = input.pythonPath
    ? [input.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    : process.env.PYTHONPATH;
  return new Promise(resolve => {
    const child = spawn(executable, ['-m', 'nl_rpg_projection_worker.main'], {
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
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      resolve({ state: 'unavailable', warnings: [error.message] });
    });
    child.on('close', code => {
      if (code !== 0) {
        resolve({ state: 'unavailable', warnings: [stderr || `Worker exited with code ${code}`] });
        return;
      }
      const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
      if (!firstLine) {
        resolve({ state: 'unavailable', warnings: ['Worker produced no response.'] });
        return;
      }
      let response: { ok: boolean; data?: unknown; error?: { message?: string } };
      try {
        response = JSON.parse(firstLine) as { ok: boolean; data?: unknown; error?: { message?: string } };
      } catch (error) {
        resolve({ state: 'unavailable', warnings: [error instanceof Error ? error.message : 'Invalid worker response.'] });
        return;
      }
      if (!response.ok) {
        resolve({ state: 'unavailable', data: response.data, warnings: [response.error?.message ?? 'Worker command failed.'] });
        return;
      }
      resolve({ state: 'available', data: response.data, warnings: [] });
    });
    child.stdin.end(`${JSON.stringify({ command: input.command, payload: input.payload ?? {} })}\n`);
  });
}
