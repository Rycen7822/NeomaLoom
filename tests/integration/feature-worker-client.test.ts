import { access, chmod, mkdir, readFile, symlink, writeFile, mkdtemp } from 'node:fs/promises';
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withTrustedCustomWorker<T>(task: () => Promise<T>): Promise<T> {
  const previous = process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER;
  process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER = '1';
  try {
    return await task();
  } finally {
    if (previous === undefined) delete process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER;
    else process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER = previous;
  }
}

describe('feature worker client', () => {
  it('runs the Python worker with an explicit package path', async () => {
    const projectRoot = await createTempProject();
    const stateDir = path.join(projectRoot, '.noemaloom');
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'client-demo' }));
    await writeProjectFile(projectRoot, '.venv/lib/python/site-packages/hidden_test.py', 'def test_hidden_worker_case(): pass\n');
    await writeProjectFile(projectRoot, 'target/debug/hidden_test.py', 'def test_hidden_target_case(): pass\n');
    await writeProjectFile(projectRoot, 'docs/oversized.md', `${'# Large ignored doc\n'}${'x'.repeat(1_100_000)}`);
    await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
    await writeFile(path.join(projectRoot, 'tests', 'binary.test.py'), Buffer.from([0xff, 0xfe, 0x00, 0x61]));

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
    expect(features.some(feature => feature.id.includes('hidden-worker-case'))).toBe(false);
    expect(features.some(feature => feature.id.includes('hidden-target-case'))).toBe(false);
    expect(features.some(feature => feature.id.includes('oversized'))).toBe(false);
    await expect(access(path.join(projectRoot, '.rpgkit'))).rejects.toThrow();
  });

  it('skips symlinked package metadata instead of following it outside the project', async () => {
    const projectRoot = await createTempProject();
    const stateDir = path.join(projectRoot, '.noemaloom');
    const outsidePackage = path.join(await createTempProject(), 'package.json');
    await writeFile(outsidePackage, JSON.stringify({ name: 'outside-package' }));
    await symlink(outsidePackage, path.join(projectRoot, 'package.json'));

    const result = await projectFeatures({
      command: 'feature.project_from_repo',
      projectRoot,
      stateDir,
      revision: 'rev-symlink-package',
      pythonExecutable: process.env.PYTHON ?? 'python3',
      pythonPath: path.join(process.cwd(), 'python', 'nl_rpg_projection_worker')
    });

    expect(result).toMatchObject({ state: 'available', warnings: [] });
    const features = JSON.parse(await readFile(path.join(stateDir, 'planning', 'features.json'), 'utf8')) as Array<{ id: string }>;
    expect(features.some(feature => feature.id === 'package:outside-package')).toBe(false);
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

  it('preserves UTF-8 worker output split across stdout chunks', async () => {
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'split-utf8-worker.py');
    await writeFile(
      fakeWorker,
      [
        '#!/usr/bin/env python3',
        'import os, sys, time',
        'sys.stdin.readline()',
        'payload = b\'{"ok":true,"data":{"word":"\' + "中".encode("utf-8") + b\'"}}\\n\'',
        'cut = payload.index("中".encode("utf-8")) + 1',
        'os.write(1, payload[:cut])',
        'sys.stdout.flush()',
        'time.sleep(0.05)',
        'os.write(1, payload[cut:])',
        ''
      ].join('\n')
    );
    await chmod(fakeWorker, 0o755);

    const result = await withTrustedCustomWorker(() => projectFeatures({
      command: 'feature.status',
      projectRoot,
      stateDir: path.join(projectRoot, '.noemaloom'),
      revision: 'rev-utf8',
      workerCommand: `"${fakeWorker}"`
    }));

    expect(result).toEqual({ state: 'available', data: { word: '中' }, warnings: [] });
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

  it('rejects an explicitly configured worker command unless custom workers are trusted', async () => {
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'custom worker');
    await writeFile(fakeWorker, '#!/usr/bin/env bash\nread _line\nprintf "{\\\"ok\\\":true,\\\"data\\\":{\\\"source\\\":\\\"custom\\\"}}\\n"\n');
    await chmod(fakeWorker, 0o755);

    await expect(
      projectFeatures({
        command: 'feature.status',
        projectRoot,
        stateDir: path.join(projectRoot, '.noemaloom'),
        revision: 'rev-client',
        workerCommand: `"${fakeWorker}"`
      })
    ).resolves.toMatchObject({
      state: 'unavailable',
      warnings: expect.arrayContaining([expect.stringContaining('custom featureProjection.workerCommand is disabled')])
    });
  });

  it('runs a trusted custom worker without leaking token-like environment variables', async () => {
    const previousAllow = process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER;
    const previousToken = process.env.NOEMALOOM_TEST_SECRET_TOKEN;
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'trusted-worker');
    await writeFile(
      fakeWorker,
      '#!/usr/bin/env bash\nread _line\nprintf "{\\\"ok\\\":true,\\\"data\\\":{\\\"secret\\\":\\\"%s\\\"}}\\n" "${NOEMALOOM_TEST_SECRET_TOKEN:-}"\n'
    );
    await chmod(fakeWorker, 0o755);
    process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER = '1';
    process.env.NOEMALOOM_TEST_SECRET_TOKEN = 'should-not-leak';
    try {
      await expect(
        projectFeatures({
          command: 'feature.status',
          projectRoot,
          stateDir: path.join(projectRoot, '.noemaloom'),
          revision: 'rev-client',
          workerCommand: `"${fakeWorker}"`
        })
      ).resolves.toMatchObject({ state: 'available', data: { secret: '' }, warnings: [] });
    } finally {
      if (previousAllow === undefined) delete process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER;
      else process.env.NOEMALOOM_ALLOW_CUSTOM_WORKER = previousAllow;
      if (previousToken === undefined) delete process.env.NOEMALOOM_TEST_SECRET_TOKEN;
      else process.env.NOEMALOOM_TEST_SECRET_TOKEN = previousToken;
    }
  });

  it('times out and force-kills a worker that ignores SIGTERM', async () => {
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'term-ignoring-worker');
    const pidFile = path.join(projectRoot, 'worker.pid');
    await writeFile(
      fakeWorker,
      '#!/usr/bin/env bash\ntrap "" TERM\necho "$$" > "$1"\nwhile true; do sleep 1; done\n'
    );
    await chmod(fakeWorker, 0o755);

    const result = await withTrustedCustomWorker(() => projectFeatures({
      command: 'feature.status',
      projectRoot,
      stateDir: path.join(projectRoot, '.noemaloom'),
      revision: 'rev-client',
      workerCommand: `"${fakeWorker}" "${pidFile}"`,
      timeoutMs: 50
    }));

    expect(result.state).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('timed out');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(processIsAlive(pid)).toBe(false);
  });

  it('terminates workers whose stdout exceeds the configured output cap', async () => {
    const projectRoot = await createTempProject();
    const fakeWorker = path.join(projectRoot, 'overflow-worker');
    await writeFile(
      fakeWorker,
      '#!/usr/bin/env bash\nread _line\nhead -c 4096 /dev/zero | tr "\\0" x\nprintf "\\n"\nsleep 2\n'
    );
    await chmod(fakeWorker, 0o755);

    const result = await withTrustedCustomWorker(() => projectFeatures({
      command: 'feature.status',
      projectRoot,
      stateDir: path.join(projectRoot, '.noemaloom'),
      revision: 'rev-client',
      workerCommand: `"${fakeWorker}"`,
      maxOutputBytes: 128
    }));

    expect(result.state).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('exceeded maxOutputBytes');
  });
});
