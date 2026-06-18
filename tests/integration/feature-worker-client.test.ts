import { access, chmod, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { projectFeatures } from '../../packages/core/src/feature-projection/feature-projector.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-feature-worker-client-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

describe('feature worker client', () => {
  it('runs the Python worker with an explicit package path', async () => {
    const projectRoot = await createTempProject();
    const stateDir = path.join(projectRoot, '.noemaloom');
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'client-demo' }));

    const result = await projectFeatures({
      command: 'feature.project_from_repo',
      projectRoot,
      stateDir,
      revision: 'rev-client',
      pythonExecutable: process.env.PYTHON ?? 'python3',
      pythonPath: path.join(process.cwd(), 'python', 'nl_rpg_projection_worker')
    });

    expect(result).toMatchObject({ state: 'available', warnings: [] });
    const features = JSON.parse(await readFile(path.join(stateDir, 'planning', 'features.json'), 'utf8')) as Array<{
      id: string;
      title: string;
      source: string;
    }>;
    expect(features).toContainEqual({ id: 'package:client-demo', title: 'Package client-demo', source: 'package' });
    await expect(access(path.join(projectRoot, '.rpgkit'))).rejects.toThrow();
  });

  it('degrades to unavailable when the worker cannot be started', async () => {
    const projectRoot = await createTempProject();

    await expect(
      projectFeatures({
        command: 'feature.status',
        projectRoot,
        stateDir: path.join(projectRoot, '.noemaloom'),
        revision: 'rev-client',
        pythonExecutable: '/definitely-missing-noemaloom-python'
      })
    ).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('degrades to unavailable when the worker returns malformed output', async () => {
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'fake-worker');
    await writeFile(fakeWorker, '#!/usr/bin/env bash\nprintf "not-json\\n"\n');
    await chmod(fakeWorker, 0o755);

    await expect(
      projectFeatures({
        command: 'feature.status',
        projectRoot,
        stateDir: path.join(projectRoot, '.noemaloom'),
        revision: 'rev-client',
        pythonExecutable: fakeWorker
      })
    ).resolves.toMatchObject({ state: 'unavailable' });
  });
});
