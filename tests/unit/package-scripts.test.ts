import { readFile } from 'node:fs/promises';

describe('root package scripts', () => {
  it('declares the build gate required by final verification', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(pkg.scripts).toMatchObject({
      build: 'tsc --noEmit'
    });
  });
});
