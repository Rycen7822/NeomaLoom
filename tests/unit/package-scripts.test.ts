import { readFile } from 'node:fs/promises';

describe('package scripts', () => {
  it('declares build gates that compile TypeScript and copy runtime assets', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: Record<string, string> };
    const corePkg = JSON.parse(await readFile('packages/core/package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts).toMatchObject({
      build: 'tsc -p tsconfig.build.json && node scripts/copy-build-assets.mjs',
      test: 'vitest run tests/unit',
      'test:unit': 'vitest run tests/unit',
      'test:integration': 'vitest run tests/integration',
      'test:e2e': 'vitest run tests/e2e',
      'test:all': 'vitest run',
      typecheck: 'tsc --noEmit'
    });
    expect(corePkg.scripts).toMatchObject({
      build: 'tsc -p ../../tsconfig.build.json && node ../../scripts/copy-build-assets.mjs',
      typecheck: 'tsc --noEmit'
    });
  });
});
