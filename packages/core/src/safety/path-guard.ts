import { open, appendFile, lstat, mkdir, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export class StatePathGuardError extends Error {
  readonly code = 'write_outside_state_dir';
  readonly path: string;
  readonly stateDir: string;

  constructor(targetPath: string, stateDir: string) {
    super(`Refusing to write outside ${stateDir}: ${targetPath}`);
    this.name = 'StatePathGuardError';
    this.path = targetPath;
    this.stateDir = stateDir;
  }
}

export function getStateDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.noemaloom');
}

export function assertWritableStatePath(projectRoot: string, targetPath: string): string {
  const stateDir = getStateDir(projectRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(stateDir, resolvedTarget);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new StatePathGuardError(resolvedTarget, stateDir);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function lstatIfExists(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function assertNoSymlinkEscape(projectRoot: string, targetPath: string): Promise<void> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  const stateDir = getStateDir(projectRoot);
  const stateDirStat = await lstatIfExists(stateDir);

  if (stateDirStat?.isSymbolicLink()) {
    throw new StatePathGuardError(safePath, stateDir);
  }

  const relative = path.relative(stateDir, safePath);
  if (relative === '') {
    return;
  }

  let currentPath = stateDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const currentStat = await lstatIfExists(currentPath);

    if (!currentStat) {
      return;
    }

    if (currentStat.isSymbolicLink()) {
      throw new StatePathGuardError(safePath, stateDir);
    }
  }
}

export async function mkdirInsideStateDir(projectRoot: string, targetPath: string): Promise<string> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await mkdir(safePath, { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safePath);
  return safePath;
}

export async function writeFileInsideStateDir(
  projectRoot: string,
  targetPath: string,
  data: string | Uint8Array
): Promise<string> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await mkdir(path.dirname(safePath), { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safePath);
  await writeFile(safePath, data);
  return safePath;
}

export async function appendFileInsideStateDir(
  projectRoot: string,
  targetPath: string,
  data: string | Uint8Array
): Promise<string> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await mkdir(path.dirname(safePath), { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safePath);
  await appendFile(safePath, data);
  return safePath;
}

export async function openExclusiveFileInsideStateDir(
  projectRoot: string,
  targetPath: string
): Promise<FileHandle> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await mkdir(path.dirname(safePath), { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safePath);
  return open(safePath, 'wx');
}

export async function unlinkInsideStateDir(projectRoot: string, targetPath: string): Promise<void> {
  await unlink(assertWritableStatePath(projectRoot, targetPath));
}
