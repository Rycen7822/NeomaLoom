import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1'
};

const GIT_SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'credential.helper='];

function gitArgs(projectRoot: string, args: string[]): string[] {
  return ['-C', projectRoot, ...GIT_SAFE_ARGS, ...args];
}

export async function isGitRepository(projectRoot: string): Promise<boolean> {
  try {
    await execFileAsync('git', gitArgs(projectRoot, ['rev-parse', '--is-inside-work-tree']), { env: GIT_ENV });
    return true;
  } catch {
    return false;
  }
}

export async function listGitVisibleFiles(projectRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    gitArgs(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard']),
    { maxBuffer: 20 * 1024 * 1024, env: GIT_ENV }
  );

  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .sort();
}
