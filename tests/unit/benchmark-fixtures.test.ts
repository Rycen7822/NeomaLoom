import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const fixtureDir = path.join('benchmarks', 'fixtures');
const allowedTools = new Set(['nl_prepare_context', 'nl_verify_task']);

type BenchmarkFixture = {
  schemaVersion?: unknown;
  kind?: unknown;
  name?: unknown;
  fixtureProject?: unknown;
  tool?: unknown;
  input?: unknown;
  expected?: unknown;
};

async function pathExists(repoPath: string): Promise<boolean> {
  try {
    await stat(repoPath);
    return true;
  } catch {
    return false;
  }
}

describe('benchmark fixtures', () => {
  it('keeps locator and verifier benchmark seeds small, typed, and reachable', async () => {
    const files = (await readdir(fixtureDir)).filter(file => file.endsWith('.json')).sort();
    expect(files).toEqual(['locator-scheduler-api-change.json', 'verifier-scheduler-doc-sync.json']);

    for (const file of files) {
      const parsed = JSON.parse(await readFile(path.join(fixtureDir, file), 'utf8')) as BenchmarkFixture;
      expect(parsed.schemaVersion).toBe(1);
      expect(['locator', 'verifier']).toContain(parsed.kind);
      expect(typeof parsed.name).toBe('string');
      expect(typeof parsed.fixtureProject).toBe('string');
      expect(await pathExists(parsed.fixtureProject as string)).toBe(true);
      expect(allowedTools.has(parsed.tool as string)).toBe(true);
      expect(typeof parsed.input).toBe('object');
      expect(typeof parsed.expected).toBe('object');
    }
  });
});
