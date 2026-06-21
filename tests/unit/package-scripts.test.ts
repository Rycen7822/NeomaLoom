import { readFile } from 'node:fs/promises';

describe('root package scripts', () => {
  it('declares the build gate required by final verification', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(pkg.scripts).toMatchObject({
      build: 'tsc -p tsconfig.build.json',
      test: 'vitest run tests/unit',
      'test:unit': 'vitest run tests/unit',
      'test:integration': 'vitest run tests/integration',
      'test:e2e': 'vitest run tests/e2e',
      'test:all': 'vitest run',
      typecheck: 'tsc --noEmit'
    });
  });
});
