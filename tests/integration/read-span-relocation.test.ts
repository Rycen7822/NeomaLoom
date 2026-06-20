import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callInternalTool, callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-read-span-'));
  await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
  await writeProjectFile(
    projectRoot,
    'src/large_module.py',
    [
      '"""Large module fixture for span sizing."""',
      'LARGE_MODULE_SENTINEL = True',
      ...Array.from({ length: 220 }, (_, index) => `VALUE_${index} = ${index}`),
      ''
    ].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'docs/api/client.md',
    [
      '# Client API',
      '',
      '## createClient',
      '',
      'The stable paragraph mentions `createClient` and timeout options.',
      '',
      '## Large Fence',
      '',
      '```ts',
      ...Array.from({ length: 170 }, (_, index) => `const line${index} = ${index};`),
      '```',
      ''
    ].join('\n')
  );
  return projectRoot;
}

describe('nl_read_span relocation and block sizing', () => {
  it('relocates a span after line drift and reads from current disk content', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read createClient timeout paragraph',
      targetRoles: ['canonical_api_doc'],
      limit: 5
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; label: string; startLine: number }>;
    };
    const target = locateData.targets.find((item: { path: string; kind: string; label: string }) =>
      item.path === 'docs/api/client.md' &&
      item.kind === 'doc.paragraph' &&
      item.label.includes('createClient')
    );
    expect(target).toBeTruthy();
    if (!target) {
      throw new Error('target span was not located');
    }

    const docPath = path.join(projectRoot, 'docs/api/client.md');
    const original = await readFile(docPath, 'utf8');
    await writeFile(docPath, ['# Preface', '', 'Inserted drift line.', '', original].join('\n'), 'utf8');

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: target.spanId,
      contextLines: 1
    });

    expect(read.ok).toBe(true);
    expect(read.data.path).toBe('docs/api/client.md');
    expect(read.data.relocation).toMatchObject({ used: true, method: 'text_hash' });
    expect(read.data.spanStartLine).toBeGreaterThan(target.startLine);
    expect(read.data.content).toContain('The stable paragraph mentions `createClient` and timeout options.');
  });

  it('returns segment ranges instead of truncating oversized Markdown code fences', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read Large Fence code fence',
      targetRoles: ['canonical_api_doc'],
      limit: 20
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; headingPath: string[]; startLine: number; endLine: number }>;
    };
    const fence = locateData.targets.find((item: { path: string; kind: string; headingPath: string[] }) =>
      item.path === 'docs/api/client.md' &&
      item.kind === 'doc.code_fence' &&
      item.headingPath.includes('Large Fence')
    );
    expect(fence).toBeTruthy();
    if (!fence) {
      throw new Error('fence span was not located');
    }

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: fence.spanId,
      contextLines: 0
    });

    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({
      status: 'block_too_large',
      path: 'docs/api/client.md',
      spanStartLine: fence.startLine,
      spanEndLine: fence.endLine,
      segmentRanges: expect.arrayContaining([
        expect.objectContaining({ startLine: fence.startLine, endLine: expect.any(Number) })
      ])
    });
    expect(read.data.content).toBe('');
  });

  it('returns segment ranges instead of whole content for oversized code modules', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read LARGE_MODULE_SENTINEL large_module module',
      targetRoles: ['source'],
      limit: 20
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; startLine: number; endLine: number }>;
    };
    const moduleSpan = locateData.targets.find((item: { path: string; kind: string }) =>
      item.path === 'src/large_module.py' &&
      item.kind === 'code.module'
    );
    expect(moduleSpan).toBeTruthy();
    if (!moduleSpan) {
      throw new Error('large module span was not located');
    }

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: moduleSpan.spanId,
      contextLines: 0,
      maxLines: 80
    });

    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({
      status: 'block_too_large',
      path: 'src/large_module.py',
      spanStartLine: moduleSpan.startLine,
      spanEndLine: moduleSpan.endLine,
      segmentRanges: expect.arrayContaining([
        expect.objectContaining({ startLine: moduleSpan.startLine, endLine: expect.any(Number) })
      ])
    });
    expect(read.data.content).toBe('');
  });

  it('returns a clear relocation failure when a changed span cannot be found', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read createClient timeout paragraph',
      targetRoles: ['canonical_api_doc'],
      limit: 5
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; label: string }>;
    };
    const target = locateData.targets.find((item: { path: string; kind: string; label: string }) =>
      item.path === 'docs/api/client.md' &&
      item.kind === 'doc.paragraph' &&
      item.label.includes('createClient')
    );
    expect(target).toBeTruthy();
    if (!target) {
      throw new Error('target span was not located');
    }

    await writeFile(
      path.join(projectRoot, 'docs/api/client.md'),
      ['# Client API', '', '## createClient', '', 'This paragraph no longer shares indexed words.', ''].join('\n'),
      'utf8'
    );

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: target.spanId,
      contextLines: 1
    });

    expect(read.ok).toBe(false);
    expect(read.graphState).toBe('stale');
    expect(read.data).toEqual({ status: 'span_relocation_failed' });
    expect(read.warnings[0]).toMatchObject({
      code: 'span_relocation_failed',
      severity: 'error'
    });
  });

  it('keeps non-block reads within maxLines while preserving the target span', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read createClient timeout paragraph',
      targetRoles: ['canonical_api_doc'],
      limit: 5
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; label: string }>;
    };
    const target = locateData.targets.find((item: { path: string; kind: string; label: string }) =>
      item.path === 'docs/api/client.md' &&
      item.kind === 'doc.paragraph' &&
      item.label.includes('createClient')
    );
    expect(target).toBeTruthy();
    if (!target) {
      throw new Error('target span was not located');
    }

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: target.spanId,
      contextLines: 80,
      maxLines: 3
    });

    expect(read.ok).toBe(true);
    const readData = read.data as { startLine: number; endLine: number; spanStartLine: number; spanEndLine: number; content: string };
    expect(readData.endLine - readData.startLine + 1).toBeLessThanOrEqual(3);
    expect(readData.startLine).toBeLessThanOrEqual(readData.spanStartLine);
    expect(readData.endLine).toBeGreaterThanOrEqual(readData.spanEndLine);
    expect(readData.content).toContain('The stable paragraph mentions `createClient` and timeout options.');
  });
});
