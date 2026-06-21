import path from 'node:path';

import {
  createCodeSpanId,
  createConfigSpanId,
  createDocumentSpanId,
  createFeatureSpanId,
  createTestExampleSpanId
} from '../../packages/core/src/spans/span-id.js';

function expectStablePrefixedId(prefix: string, first: string, second: string, changed: string): void {
  expect(first).toBe(second);
  expect(first).toMatch(new RegExp(`^${prefix}:[a-f0-9]{40}$`));
  expect(changed).not.toBe(first);
}

describe('stable span ids', () => {
  it('creates deterministic prefixed code span ids and changes when identity inputs change', () => {
    const base = {
      projectRoot: path.resolve('/tmp/noemaloom-project'),
      path: 'src/api.ts',
      kind: 'code.function' as const,
      qualifiedName: 'createClient',
      signatureHash: 'sig-a'
    };

    expectStablePrefixedId(
      'code',
      createCodeSpanId(base),
      createCodeSpanId({ ...base }),
      createCodeSpanId({ ...base, signatureHash: 'sig-b' })
    );
  });

  it('creates deterministic prefixed document span ids and changes when block identity changes', () => {
    const base = {
      projectRoot: path.resolve('/tmp/noemaloom-project'),
      path: 'docs/api/client.md',
      headingPath: ['Client API', 'Options'],
      kind: 'doc.paragraph' as const,
      blockOrdinal: 4,
      normalizedTextHash: 'text-a'
    };

    expectStablePrefixedId(
      'doc',
      createDocumentSpanId(base),
      createDocumentSpanId({ ...base }),
      createDocumentSpanId({ ...base, blockOrdinal: 5 })
    );
  });

  it('creates deterministic prefixed config span ids and changes when config identity changes', () => {
    const base = {
      projectRoot: path.resolve('/tmp/noemaloom-project'),
      path: 'package.json',
      jsonPointerOrTomlPath: '/scripts/test',
      normalizedValueHash: 'value-a'
    };

    expectStablePrefixedId(
      'config',
      createConfigSpanId(base),
      createConfigSpanId({ ...base }),
      createConfigSpanId({ ...base, normalizedValueHash: 'value-b' })
    );
  });

  it('creates deterministic prefixed test/example span ids and changes when locator disambiguators change', () => {
    const base = {
      projectRoot: path.resolve('/tmp/noemaloom-project'),
      path: 'tests/client.test.ts',
      kind: 'test.case' as const,
      testOrExampleName: 'creates client',
      normalizedTextHash: 'test-a'
    };

    expectStablePrefixedId(
      'tx',
      createTestExampleSpanId(base),
      createTestExampleSpanId({ ...base }),
      createTestExampleSpanId({ ...base, startLine: 42 })
    );
  });

  it('creates deterministic prefixed feature span ids and changes when source identity changes', () => {
    const base = {
      projectRoot: path.resolve('/tmp/noemaloom-project'),
      featurePath: 'features/client.md',
      featureLabel: 'Client setup',
      sourceId: 'feature-1'
    };

    expectStablePrefixedId(
      'feature',
      createFeatureSpanId(base),
      createFeatureSpanId({ ...base }),
      createFeatureSpanId({ ...base, sourceId: 'feature-2' })
    );
  });
});
