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
        }
      ]
    });
    expect(JSON.parse(await readFile(paths.configFile, 'utf8')).indexing.maxFileBytes).toBe('large');
  });
});
