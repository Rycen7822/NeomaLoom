import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createCodeSpanId,
  createConfigSpanId,
  createDocumentSpanId,
  createFeatureSpanId,
  createTestExampleSpanId
} from '../../packages/core/src/spans/span-id.js';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

describe('stable span ids', () => {
  it('uses the five canonical formulas deterministically', () => {
    const projectRoot = path.resolve('/tmp/noemaloom-project');

    expect(
      createCodeSpanId({
        projectRoot,
        path: 'src/api.ts',
        kind: 'code.function',
        qualifiedName: 'createClient',
        signatureHash: 'sig-a'
      })
    ).toBe(`code:${sha1(`${projectRoot}src/api.tscode.functioncreateClientsig-a`)}`);

    expect(
      createDocumentSpanId({
        projectRoot,
        path: 'docs/api/client.md',
        headingPath: ['Client API', 'Options'],
        kind: 'doc.paragraph',
        blockOrdinal: 4,
        normalizedTextHash: 'text-a'
      })
    ).toBe(`doc:${sha1(`${projectRoot}docs/api/client.md${JSON.stringify(['Client API', 'Options'])}doc.paragraph4text-a`)}`);

    expect(
      createConfigSpanId({
        projectRoot,
        path: 'package.json',
        jsonPointerOrTomlPath: '/scripts/test',
        normalizedValueHash: 'value-a'
      })
    ).toBe(`config:${sha1(`${projectRoot}package.json/scripts/testvalue-a`)}`);

    expect(
      createTestExampleSpanId({
        projectRoot,
        path: 'tests/client.test.ts',
        kind: 'test.case',
        testOrExampleName: 'creates client',
        normalizedTextHash: 'test-a'
      })
    ).toBe(`tx:${sha1(`${projectRoot}tests/client.test.tstest.casecreates clienttest-a`)}`);

    expect(
      createFeatureSpanId({
        projectRoot,
        featurePath: 'features/client.md',
        featureLabel: 'Client setup',
        sourceId: 'feature-1'
      })
    ).toBe(`feature:${sha1(`${projectRoot}features/client.mdClient setupfeature-1`)}`);

    expect(
      createTestExampleSpanId({
        projectRoot,
        path: 'tests/client.test.ts',
        kind: 'test.case',
        testOrExampleName: 'creates client',
        normalizedTextHash: 'test-a',
        startLine: 42
      })
    ).toBe(`tx:${sha1(`${projectRoot}tests/client.test.tstest.casecreates clienttest-a42`)}`);
  });

  it('changes only when formula inputs change', () => {
    const baseInput = {
      projectRoot: '/tmp/noemaloom-project',
      path: 'src/api.ts',
      kind: 'code.function' as const,
      qualifiedName: 'createClient',
      signatureHash: 'sig-a'
    };

    expect(createCodeSpanId(baseInput)).toBe(createCodeSpanId({ ...baseInput }));
    expect(createCodeSpanId(baseInput)).not.toBe(
      createCodeSpanId({
        ...baseInput,
        signatureHash: 'sig-b'
      })
    );
  });
});
