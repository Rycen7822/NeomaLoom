import { runFeatureWorkerCommand, type FeatureWorkerCommand, type FeatureWorkerResult } from './worker-client.js';

export async function projectFeatures(input: {
  command: FeatureWorkerCommand;
  projectRoot: string;
  stateDir: string;
  revision: string;
  payload?: Record<string, unknown>;
  pythonExecutable?: string;
  pythonPath?: string;
}): Promise<FeatureWorkerResult> {
  return runFeatureWorkerCommand(input);
}
