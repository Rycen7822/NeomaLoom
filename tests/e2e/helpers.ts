import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function copyFixture(name: string): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), `noemaloom-${name}-`));
  await cp(path.join(process.cwd(), 'tests', 'fixtures', name), target, { recursive: true });
  return target;
}

export async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

export async function replaceInFile(projectRoot: string, repoPath: string, from: string, to: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  const text = await readFile(absolutePath, 'utf8');
  await writeFile(absolutePath, text.split(from).join(to), 'utf8');
}
