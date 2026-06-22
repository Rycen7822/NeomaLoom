import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { open, lstat, mkdir, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | O_NOFOLLOW;
const APPEND_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | O_NOFOLLOW;
const EXCLUSIVE_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

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

export class ProjectReadPathGuardError extends Error {
  readonly code = 'read_outside_project_root';
  readonly path: string;
  readonly projectRoot: string;

  constructor(targetPath: string, projectRoot: string) {
    super(`Refusing to read outside ${projectRoot}: ${targetPath}`);
    this.name = 'ProjectReadPathGuardError';
    this.path = targetPath;
    this.projectRoot = projectRoot;
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

function isInsideRoot(root: string, targetPath: string): boolean {
  const relative = path.relative(root, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeProjectRelativePath(projectRoot: string, rawPath: string): string {
  const root = path.resolve(projectRoot);
  const normalizedRaw = rawPath.replaceAll('\\', '/');
  const absolute = path.isAbsolute(normalizedRaw) ? path.resolve(normalizedRaw) : path.resolve(root, normalizedRaw);

  if (!isInsideRoot(root, absolute)) {
    throw new ProjectReadPathGuardError(absolute, root);
  }

  return path.relative(root, absolute).replaceAll('\\', '/');
}

export function resolveProjectReadPath(projectRoot: string, rawPath: string): string {
  const root = path.resolve(projectRoot);
  return path.join(root, normalizeProjectRelativePath(root, rawPath));
}

async function assertNoProjectSymlinkEscape(projectRoot: string, targetPath: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const safePath = resolveProjectReadPath(root, targetPath);
  const relative = path.relative(root, safePath);
  if (relative === '') {
    return;
  }

  let currentPath = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const currentStat = await lstatIfExists(currentPath);
    if (!currentStat) {
      return;
    }
    if (currentStat.isSymbolicLink()) {
      throw new ProjectReadPathGuardError(safePath, root);
    }
  }
}

function lstatIfExistsSync(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertNoProjectSymlinkEscapeSync(projectRoot: string, targetPath: string): void {
  const root = path.resolve(projectRoot);
  const safePath = resolveProjectReadPath(root, targetPath);
  const relative = path.relative(root, safePath);
  if (relative === '') {
    return;
  }

  let currentPath = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const currentStat = lstatIfExistsSync(currentPath);
    if (!currentStat) {
      return;
    }
    if (currentStat.isSymbolicLink()) {
      throw new ProjectReadPathGuardError(safePath, root);
    }
  }
}

export async function safeStatInsideProject(projectRoot: string, rawPath: string) {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  await assertNoProjectSymlinkEscape(projectRoot, safePath);
  return stat(safePath);
}

export function safeStatInsideProjectSync(projectRoot: string, rawPath: string) {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  assertNoProjectSymlinkEscapeSync(projectRoot, safePath);
  return statSync(safePath);
}

export async function safeLstatInsideProject(projectRoot: string, rawPath: string) {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  await assertNoProjectSymlinkEscape(projectRoot, safePath);
  return lstat(safePath);
}

export async function safeReaddirInsideProject(projectRoot: string, rawPath: string, options: { withFileTypes: true }) {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  await assertNoProjectSymlinkEscape(projectRoot, safePath);
  return readdir(safePath, options);
}

export async function safeReadFileInsideProject(projectRoot: string, rawPath: string): Promise<Buffer>;
export async function safeReadFileInsideProject(projectRoot: string, rawPath: string, encoding: BufferEncoding): Promise<string>;
export async function safeReadFileInsideProject(projectRoot: string, rawPath: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  await assertNoProjectSymlinkEscape(projectRoot, safePath);
  const handle = await open(safePath, READ_NOFOLLOW_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ProjectReadPathGuardError(safePath, path.resolve(projectRoot));
    }
    const data = await handle.readFile();
    return encoding ? data.toString(encoding) : data;
  } finally {
    await handle.close();
  }
}

export function safeReadFileInsideProjectSync(projectRoot: string, rawPath: string, encoding: BufferEncoding): string {
  const safePath = resolveProjectReadPath(projectRoot, rawPath);
  assertNoProjectSymlinkEscapeSync(projectRoot, safePath);
  const fd = openSync(safePath, READ_NOFOLLOW_FLAGS);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new ProjectReadPathGuardError(safePath, path.resolve(projectRoot));
    }
    return readFileSync(fd).toString(encoding);
  } finally {
    closeSync(fd);
  }
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

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every filesystem/runtime; file fsync remains strict.
  } finally {
    await handle?.close();
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
  const tempBaseName = path.basename(safePath).replace(/^\.+/, '') || 'state';
  const tempPath = assertWritableStatePath(
    projectRoot,
    path.join(path.dirname(safePath), `.tmp-${tempBaseName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`)
  );
  await assertNoSymlinkEscape(projectRoot, tempPath);
  let wroteTemp = false;
  let tempHandle: FileHandle | undefined;
  try {
    tempHandle = await open(tempPath, EXCLUSIVE_NOFOLLOW_FLAGS);
    wroteTemp = true;
    if (!(await tempHandle.stat()).isFile()) {
      throw new StatePathGuardError(tempPath, getStateDir(projectRoot));
    }
    await tempHandle.writeFile(data);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;
    await rename(tempPath, safePath);
    wroteTemp = false;
    await syncDirectoryBestEffort(path.dirname(safePath));
    return safePath;
  } finally {
    await tempHandle?.close();
    if (wroteTemp) {
      try {
        await unlink(tempPath);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
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
  const handle = await open(safePath, APPEND_NOFOLLOW_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new StatePathGuardError(safePath, getStateDir(projectRoot));
    }
    await handle.writeFile(data);
    return safePath;
  } finally {
    await handle.close();
  }
}

export async function openExclusiveFileInsideStateDir(
  projectRoot: string,
  targetPath: string,
  initialData?: string | Uint8Array
): Promise<FileHandle> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await mkdir(path.dirname(safePath), { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safePath);
  const handle = await open(safePath, EXCLUSIVE_NOFOLLOW_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new StatePathGuardError(safePath, getStateDir(projectRoot));
    }
    if (initialData !== undefined) {
      await handle.writeFile(initialData);
      await handle.sync();
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function unlinkInsideStateDir(projectRoot: string, targetPath: string): Promise<void> {
  const safePath = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safePath);
  await unlink(safePath);
}

export async function renameInsideStateDir(projectRoot: string, sourcePath: string, targetPath: string): Promise<void> {
  const safeSource = assertWritableStatePath(projectRoot, sourcePath);
  const safeTarget = assertWritableStatePath(projectRoot, targetPath);
  await assertNoSymlinkEscape(projectRoot, safeSource);
  await mkdir(path.dirname(safeTarget), { recursive: true });
  await assertNoSymlinkEscape(projectRoot, safeTarget);
  await rename(safeSource, safeTarget);
  await syncDirectoryBestEffort(path.dirname(safeTarget));
}
