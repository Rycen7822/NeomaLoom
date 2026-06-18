import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceMapPath = join(process.cwd(), 'vendor/source-audit/source-map.md');

describe('source audit map policy', () => {
  it('records reference sources and cropped upstream behaviors', () => {
    const sourceMap = readFileSync(sourceMapPath, 'utf8');

    for (const requiredSource of [
      'CodeGraph',
      'RPG-ZeroRepo',
      'MCP TypeScript SDK',
      'remark',
      'MDX',
      'tree-sitter'
    ]) {
      expect(sourceMap).toContain(requiredSource);
    }

    for (const croppedBehavior of [
      'installer',
      'hooks',
      'raw tools',
      'writer',
      'codegen'
    ]) {
      expect(sourceMap).toContain(croppedBehavior);
    }
  });
});
