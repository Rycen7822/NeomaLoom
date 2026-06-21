import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callInternalTool, callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { run: (...params: unknown[]) => void; get: (...params: unknown[]) => unknown };
    close: () => void;
  };
};

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
  await writeProjectFile(
    projectRoot,
    'docs/secrets.md',
    [
      '# Secrets',
      '',
      'The fake fixture api_key = "abcdefghijklmnop1234567890" must be redacted from tool output.',
      ''
    ].join('\n')
  );
  return projectRoot;
}

function poisonSpanPath(projectRoot: string, spanId: string, unsafePath: string): void {
  const db = new DatabaseSync(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'));
  try {
    db.prepare('UPDATE repo_spans SET path = ? WHERE span_id = ?').run(unsafePath, spanId);
  } finally {
    db.close();
  }
}

function readSpanByPathKind(projectRoot: string, repoPath: string, kind: string): { spanId: string; metadataJson: string } | undefined {
  const db = new DatabaseSync(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'));
  try {
    return db
      .prepare('SELECT span_id AS spanId, metadata_json AS metadataJson FROM repo_spans WHERE path = ? AND kind = ? LIMIT 1')
      .get(repoPath, kind) as { spanId: string; metadataJson: string } | undefined;
  } finally {
    db.close();
  }
}

describe('nl_read_span relocation and block sizing', () => {
  it('returns span_index_missing instead of handler_error when the span DB is absent', async () => {
    const projectRoot = await createProject();

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: 'missing-span-id'
    });

    expect(read.ok).toBe(false);
    expect(read.graphState).toBe('empty');
    expect(read.data).toEqual({ status: 'span_index_missing' });
    expect(read.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'span_index_missing', severity: 'error' })])
    );
    expect(JSON.stringify(read)).not.toContain('handler_error');
    expect(read.nextActions).toEqual(expect.arrayContaining([expect.stringContaining('nl_refresh')]));
  });

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

  it('rejects DB-poisoned span paths that escape the project root', async () => {
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
    const original = await readFile(path.join(projectRoot, 'docs/api/client.md'), 'utf8');
    await writeFile(path.join(path.dirname(projectRoot), 'outside.md'), original, 'utf8');
    poisonSpanPath(projectRoot, target.spanId, '../outside.md');

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: target.spanId,
      contextLines: 1
    });

    expect(read.ok).toBe(false);
    expect(read.data).toEqual({ status: 'unsafe_span_path' });
    expect(read.warnings[0]).toMatchObject({
      code: 'unsafe_span_path',
      severity: 'error'
    });
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
      contentStatus: 'preview',
      segmentRanges: expect.arrayContaining([
        expect.objectContaining({ startLine: fence.startLine, endLine: expect.any(Number) })
      ])
    });
    expect(read.data.content).toContain('```ts');
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
      contentStatus: 'preview',
      segmentRanges: expect.arrayContaining([
        expect.objectContaining({ startLine: moduleSpan.startLine, endLine: expect.any(Number) })
      ])
    });
    expect(read.data.content).toContain('LARGE_MODULE_SENTINEL');
  });

  it('uses focus lines to preview the relevant segment of an oversized code module', async () => {
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
      maxLines: 80,
      focusLine: moduleSpan.startLine + 170
    });

    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({ status: 'block_too_large', path: 'src/large_module.py' });
    expect(read.data.startLine).toBeGreaterThan(moduleSpan.startLine);
    expect(read.data.content).toContain('VALUE_170 = 170');
    expect(read.data.content).not.toContain('LARGE_MODULE_SENTINEL');
  });

  it('relocates truncated large code spans by prefix after line drift', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(
      projectRoot,
      'src/truncated_module.py',
      [
        'TRUNCATED_PREFIX_SENTINEL = True',
        ...Array.from({ length: 1200 }, (_, index) => `VALUE_${index} = ${index}`),
        ''
      ].join('\n')
    );
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const moduleSpan = readSpanByPathKind(projectRoot, 'src/truncated_module.py', 'code.module');
    expect(moduleSpan).toBeTruthy();
    if (!moduleSpan) {
      throw new Error('truncated module span was not indexed');
    }
    expect(JSON.parse(moduleSpan.metadataJson)).toMatchObject({ indexedTextTruncatedAtWrite: true });

    const modulePath = path.join(projectRoot, 'src/truncated_module.py');
    const original = await readFile(modulePath, 'utf8');
    await writeFile(modulePath, ['# inserted line drift', original].join('\n'), 'utf8');

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: moduleSpan.spanId,
      contextLines: 0,
      maxLines: 80
    });

    expect(read.ok).toBe(true);
    expect(read.graphState).toBe('stale');
    expect(read.data).toMatchObject({
      status: 'block_too_large',
      path: 'src/truncated_module.py',
      contentStatus: 'preview',
      relocation: { used: true, method: 'truncated_prefix_search' }
    });
    expect(read.data.content).toContain('TRUNCATED_PREFIX_SENTINEL');
  });

  it('relocates truncated large code spans by line fingerprint when the stored prefix changed', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(
      projectRoot,
      'src/truncated_module.py',
      [
        'TRUNCATED_PREFIX_SENTINEL = True',
        ...Array.from({ length: 1200 }, (_, index) => `VALUE_${index} = ${index}`),
        ''
      ].join('\n')
    );
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const moduleSpan = readSpanByPathKind(projectRoot, 'src/truncated_module.py', 'code.module');
    expect(moduleSpan).toBeTruthy();
    if (!moduleSpan) {
      throw new Error('truncated module span was not indexed');
    }
    expect(JSON.parse(moduleSpan.metadataJson)).toMatchObject({ indexedTextTruncatedAtWrite: true });

    const modulePath = path.join(projectRoot, 'src/truncated_module.py');
    const original = await readFile(modulePath, 'utf8');
    await writeFile(modulePath, original.replace('TRUNCATED_PREFIX_SENTINEL = True', 'CHANGED_PREFIX_SENTINEL = True'), 'utf8');

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: moduleSpan.spanId,
      contextLines: 0,
      maxLines: 80
    });

    expect(read.ok).toBe(true);
    expect(read.graphState).toBe('stale');
    expect(read.data).toMatchObject({
      status: 'block_too_large',
      path: 'src/truncated_module.py',
      contentStatus: 'preview',
      relocation: { used: true, method: 'line_fingerprint_search' }
    });
    expect(read.data.content).toContain('CHANGED_PREFIX_SENTINEL');
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

  it('redacts sensitive-looking current file content while preserving original hashes', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const locate = await callInternalTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Read Secrets fixture paragraph',
      targetRoles: ['document'],
      limit: 5
    });
    const locateData = locate.data as {
      targets: Array<{ spanId: string; path: string; kind: string; label: string }>;
    };
    const target = locateData.targets.find(item => item.path === 'docs/secrets.md' && item.kind === 'doc.paragraph');
    expect(target).toBeTruthy();
    if (!target) {
      throw new Error('secret paragraph was not located');
    }

    const read = await callInternalTool('nl_read_span', {
      projectPath: projectRoot,
      spanId: target.spanId,
      contextLines: 0
    });

    expect(read.ok).toBe(true);
    const readData = read.data as { content: string; redaction?: { hasSensitiveContent: boolean; redactedKinds: string[] }; spanTextHash: string; fileContentHash: string };
    expect(readData.content).toContain('[REDACTED:api_key]');
    expect(readData.content).not.toContain('abcdefghijklmnop1234567890');
    expect(readData.redaction).toEqual({ hasSensitiveContent: true, redactedKinds: ['api_key'] });
    expect(readData.spanTextHash).toMatch(/^[0-9a-f]{40}$/);
    expect(readData.fileContentHash).toMatch(/^[0-9a-f]{40}$/);
  });
});
