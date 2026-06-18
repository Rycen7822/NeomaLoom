import path from 'node:path';

export type NoemaLoomConfig = {
  schemaRevision: 1;
  projectRoot: string;
  fileInventory: {
    includeExtensions: string[];
    ignoreGlobs: string[];
  };
  indexing: {
    maxFileBytes: number;
    maxReadSpanLines: number;
    maxLocatorResults: number;
    maxTraceEdges: number;
    maxToolOutputTokens: number;
  };
  featureProjection: {
    enabled: boolean;
    workerCommand: string;
    stateDir: string;
  };
  safety: {
    denyRawToolExposure: boolean;
    denyWriter: boolean;
    denyGitHooks: boolean;
    denyExternalVectorDb: boolean;
    denyAgentConfigWrites: boolean;
  };
};

export function createDefaultConfig(projectRoot: string): NoemaLoomConfig {
  return {
    schemaRevision: 1,
    projectRoot: path.resolve(projectRoot),
    fileInventory: {
      includeExtensions: [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.py',
        '.go',
        '.rs',
        '.java',
        '.cpp',
        '.c',
        '.h',
        '.hpp',
        '.cs',
        '.rb',
        '.php',
        '.swift',
        '.kt',
        '.scala',
        '.lua',
        '.vue',
        '.svelte',
        '.md',
        '.mdx',
        '.rst',
        '.json',
        '.yaml',
        '.yml',
        '.toml'
      ],
      ignoreGlobs: [
        '.git/**',
        'node_modules/**',
        'dist/**',
        'build/**',
        '.venv/**',
        'venv/**',
        '__pycache__/**',
        '.noemaloom/**',
        'coverage/**',
        'vendor/**'
      ]
    },
    indexing: {
      maxFileBytes: 1048576,
      maxReadSpanLines: 160,
      maxLocatorResults: 40,
      maxTraceEdges: 200,
      maxToolOutputTokens: 2500
    },
    featureProjection: {
      enabled: true,
      workerCommand: 'python -m nl_rpg_projection_worker.main',
      stateDir: '.noemaloom/planning'
    },
    safety: {
      denyRawToolExposure: true,
      denyWriter: true,
      denyGitHooks: true,
      denyExternalVectorDb: true,
      denyAgentConfigWrites: true
    }
  };
}
