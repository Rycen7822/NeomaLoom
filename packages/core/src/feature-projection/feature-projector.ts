import { runFeatureWorkerCommand, type FeatureWorkerCommand, type FeatureWorkerResult } from './worker-client.js';

export async function projectFeatures(input: {
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
  return runFeatureWorkerCommand(input);
}
