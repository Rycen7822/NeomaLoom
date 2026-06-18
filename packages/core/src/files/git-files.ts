import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function isGitRepository(projectRoot: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export async function listGitVisibleFiles(projectRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 20 * 1024 * 1024 }
  );

  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .sort();
}
