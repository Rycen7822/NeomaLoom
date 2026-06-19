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
