import { indexArtifactSpans } from '../../packages/core/src/artifacts/artifact-span-indexer.js';

describe('ArtifactSpanIndexer', () => {
  it('extracts JSON pointers, schema fields, env vars, CLI flags, and config keys', () => {
    const result = indexArtifactSpans({
      path: 'config/app.schema.json',
      text: JSON.stringify(
        {
          properties: {
            timeoutMs: { type: 'number' }
          },
          server: {
            env: 'NOEMALOOM_TOKEN',
            flag: '--dry-run'
          }
        },
        null,
        2
      )
    });

    expect(result.spans.find(span => span.kind === 'config.file')).toMatchObject({
      label: 'app.schema.json',
      startLine: 1
    });
    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: 'timeoutMs',
          metadata: expect.objectContaining({
            pointer: '/properties/timeoutMs',
            schemaFieldName: 'timeoutMs'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: 'NOEMALOOM_TOKEN',
          metadata: expect.objectContaining({
            envVar: 'NOEMALOOM_TOKEN'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: '--dry-run',
          metadata: expect.objectContaining({
            cliFlag: '--dry-run'
          })
        })
      ])
    );
  });

  it('indexes JSON array values as config.array_item spans with pointers', () => {
    const result = indexArtifactSpans({
      path: 'config/app.json',
      text: JSON.stringify({ flags: ['--dry-run'] }, null, 2)
    });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.array_item',
          label: '--dry-run',
          metadata: expect.objectContaining({
            pointer: '/flags/0',
            cliFlag: '--dry-run'
          })
        })
      ])
    );
    expect(result.spans).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: '0'
        })
      ])
    );
  });

  it('extracts YAML paths and TOML table/key paths without rendering config files', () => {
    const yaml = indexArtifactSpans({
      path: 'deploy/service.yaml',
      text: ['service:', '  env: NOEMALOOM_TOKEN', '  flag: --dry-run', ''].join('\n')
    });
    const toml = indexArtifactSpans({
      path: 'pyproject.toml',
      text: ['[tool.noemaloom]', 'mode = "strict"', 'flag = "--dry-run"', ''].join('\n')
    });

    expect(yaml.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: 'env',
          metadata: expect.objectContaining({
            yamlPath: 'service.env',
            envVar: 'NOEMALOOM_TOKEN'
          })
        })
      ])
    );
    expect(toml.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: 'mode',
          metadata: expect.objectContaining({
            tomlPath: 'tool.noemaloom.mode',
            configKey: 'mode'
          })
        })
      ])
    );
  });

  it('caps YAML and TOML artifact span counts and reports truncation', () => {
    const yaml = indexArtifactSpans({
      path: 'deploy/large.yaml',
      text: Array.from({ length: 20 }, (_, index) => `key_${index}: value_${index}`).join('\n'),
      maxSpans: 5
    });
    const toml = indexArtifactSpans({
      path: 'config/large.toml',
      text: Array.from({ length: 20 }, (_, index) => `key_${index} = "value_${index}"`).join('\n'),
      maxSpans: 5
    });

    expect(yaml.spans).toHaveLength(5);
    expect(yaml.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Artifact span limit reached (5)')]));
    expect(toml.spans).toHaveLength(5);
    expect(toml.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Artifact span limit reached (5)')]));
  });

  it('caps very large JSON artifacts and reports truncation', () => {
    const result = indexArtifactSpans({
      path: 'resources/models/vocab.json',
      text: JSON.stringify(Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [`token_${index}`, index])), null, 2),
      maxSpans: 50
    });

    expect(result.spans).toHaveLength(50);
    expect(result.spans[0]).toMatchObject({ kind: 'config.file', label: 'vocab.json' });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Artifact span limit reached (50)')]));
  });

  it('does not duplicate full minified JSON text into every config span', () => {
    const vocabulary = Object.fromEntries(
      Array.from({ length: 1500 }, (_, index) => [`token_${index}`, `value-${index}-${'x'.repeat(120)}`])
    );
    const text = JSON.stringify(vocabulary);

    const result = indexArtifactSpans({
      path: 'resources/models/vocab.json',
      text
    });

    const textLengths = result.spans.map(span => span.text.length);
    expect(Math.max(...textLengths)).toBeLessThanOrEqual(8192);
    expect(textLengths.reduce((sum, length) => sum + length, 0)).toBeLessThan(text.length * 3);
    expect(result.spans[0]).toMatchObject({
      kind: 'config.file',
      metadata: expect.objectContaining({ truncatedIndexedText: true })
    });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Artifact indexed text truncated')]));
  });

  it('bounds JSON array item labels as well as text', () => {
    const text = JSON.stringify({ values: ['y'.repeat(20000)] });

    const result = indexArtifactSpans({ path: 'config/large-array.json', text });
    const item = result.spans.find(span => span.kind === 'config.array_item');

    expect(item).toBeDefined();
    expect(item?.label.length).toBeLessThan(20000);
    expect(Buffer.byteLength(item?.label ?? '', 'utf8')).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(item?.text ?? '', 'utf8')).toBeLessThanOrEqual(8192);
    expect(item?.metadata).toMatchObject({ labelTruncated: true, truncatedIndexedText: true });
  });

  it('truncates deeply nested JSON traversal instead of recursing through the whole object', () => {
    let value: unknown = 'leaf';
    for (let index = 0; index < 180; index += 1) {
      value = { [`level_${index}`]: value };
    }

    const result = indexArtifactSpans({ path: 'config/deep.json', text: JSON.stringify(value), maxSpans: 500 });

    expect(result.spans.length).toBeLessThan(140);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('omitted')]));
  });

  it('bounds recursive package export metadata extraction', () => {
    let exportsValue: unknown = './dist/leaf.js';
    for (let index = 0; index < 120; index += 1) {
      exportsValue = { [`branch${index}`]: exportsValue };
    }

    const result = indexArtifactSpans({ path: 'package.json', text: JSON.stringify({ exports: exportsValue }, null, 2), maxSpans: 500 });

    expect(result.spans.length).toBeLessThan(180);
  });

  it('extracts package scripts, entrypoints, and workspace package names', () => {
    const result = indexArtifactSpans({
      path: 'package.json',
      text: JSON.stringify(
        {
          scripts: {
            build: 'tsc --noEmit'
          },
          main: './dist/index.js',
          exports: {
            './cli': './dist/cli.js'
          },
          bin: {
            noemaloom: './dist/cli.js'
          },
          workspaces: ['packages/core']
        },
        null,
        2
      )
    });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: 'build',
          metadata: expect.objectContaining({
            packageScript: 'build'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: './dist/index.js',
          metadata: expect.objectContaining({
            packageEntrypoint: 'main'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: './dist/cli.js',
          metadata: expect.objectContaining({
            packageEntrypoint: 'exports./cli'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: 'packages/core',
          metadata: expect.objectContaining({
            workspacePackageName: 'packages/core'
          })
        })
      ])
    );
  });

  it('extracts pyproject scripts as package scripts and entrypoints', () => {
    const result = indexArtifactSpans({
      path: 'pyproject.toml',
      text: ['[project.scripts]', 'noemaloom = "pkg.cli:main"', ''].join('\n')
    });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'config.entry',
          label: 'noemaloom',
          metadata: expect.objectContaining({
            packageScript: 'noemaloom'
          })
        }),
        expect.objectContaining({
          kind: 'config.entry',
          label: 'pkg.cli:main',
          metadata: expect.objectContaining({
            packageEntrypoint: 'project.scripts.noemaloom'
          })
        })
      ])
    );
  });
});
