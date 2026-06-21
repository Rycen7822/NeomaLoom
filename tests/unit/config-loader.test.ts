import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultConfig } from '../../packages/core/src/config/default-config.js';
import { loadOrCreateConfig } from '../../packages/core/src/config/config-loader.js';
import { ensureStateDir } from '../../packages/core/src/state/state-dir.js';
import { resolveNoemaLoomPaths } from '../../packages/core/src/state/paths.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-config-'));
}

describe('NoemaLoom config loader', () => {
  it('creates the fixed default config when config is missing', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);

    const result = await loadOrCreateConfig(projectRoot);

    expect(result).toEqual({
      ok: true,
      created: true,
      config: createDefaultConfig(projectRoot)
    });
    expect(JSON.parse(await readFile(paths.configFile, 'utf8'))).toEqual(createDefaultConfig(projectRoot));
  });

  it('returns exact field errors and does not rewrite an invalid user config', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await ensureStateDir(projectRoot);
    const validConfig = createDefaultConfig(projectRoot);
    const invalidConfig = {
      ...validConfig,
      indexing: {
        ...validConfig.indexing,
        maxFileBytes: 'large'
      },
      featureProjection: {
        ...validConfig.featureProjection,
        timeoutMs: 'slow'
      }
    };
    await writeFile(paths.configFile, `${JSON.stringify(invalidConfig, null, 2)}\n`);

    const result = await loadOrCreateConfig(projectRoot);

    expect(result).toEqual({
      ok: false,
      status: 'config_invalid',
      created: false,
      errors: [
        {
          field: 'indexing.maxFileBytes',
          message: 'indexing.maxFileBytes must be a positive integer'
        },
        {
          field: 'featureProjection.timeoutMs',
          message: 'featureProjection.timeoutMs must be a positive integer'
        }
      ]
    });
    const stored = JSON.parse(await readFile(paths.configFile, 'utf8')) as { indexing: { maxFileBytes: unknown }; featureProjection: { timeoutMs: unknown } };
    expect(stored.indexing.maxFileBytes).toBe('large');
    expect(stored.featureProjection.timeoutMs).toBe('slow');
  });

  it('normalizes old configs with additive featureProjection fields and current default ignore globs', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await ensureStateDir(projectRoot);
    const oldConfig = createDefaultConfig(projectRoot);
    oldConfig.fileInventory.ignoreGlobs = ['node_modules/**', 'custom-cache/**'];
    delete (oldConfig.featureProjection as Partial<typeof oldConfig.featureProjection>).timeoutMs;
    delete (oldConfig.featureProjection as Partial<typeof oldConfig.featureProjection>).maxOutputBytes;
    await writeFile(paths.configFile, `${JSON.stringify(oldConfig, null, 2)}\n`);

    const result = await loadOrCreateConfig(projectRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.config.featureProjection).toMatchObject({
      timeoutMs: createDefaultConfig(projectRoot).featureProjection.timeoutMs,
      maxOutputBytes: createDefaultConfig(projectRoot).featureProjection.maxOutputBytes
    });
    expect(result.config.fileInventory.ignoreGlobs).toEqual(
      expect.arrayContaining(['node_modules/**', 'custom-cache/**', '.noemaloom/**', 'hermes-plugin-backups/**'])
    );
    const stored = JSON.parse(await readFile(paths.configFile, 'utf8')) as { featureProjection: Record<string, unknown>; fileInventory: { ignoreGlobs: string[] } };
    expect(stored.featureProjection.timeoutMs).toBeUndefined();
    expect(stored.fileInventory.ignoreGlobs).toEqual(['node_modules/**', 'custom-cache/**']);
  });
});
