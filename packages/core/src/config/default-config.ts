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
    timeoutMs: number;
    maxOutputBytes: number;
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
        '.jsonl',
        '.yaml',
        '.yml',
        '.toml',
        '.ini',
        '.sql',
        '.txt',
        '.csv',
        '.sh',
        '.bash',
        '.zsh',
        '.css',
        '.html',
        '.xml'
      ],
      ignoreGlobs: [
        '.git/**',
        '.env',
        '.env.*',
        '.envrc',
        '.aws/**',
        '.gnupg/**',
        '.kube/**',
        '.ssh/**',
        '.npmrc',
        '.pypirc',
        '.netrc',
        '.git-credentials',
        'id_rsa',
        'id_dsa',
        'id_ecdsa',
        'id_ed25519',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        '**/secrets.json',
        '**/secrets.yaml',
        '**/secrets.yml',
        '**/secrets.toml',
        '**/secrets.ini',
        '**/secret.json',
        '**/secret.yaml',
        '**/secret.yml',
        '**/secret.toml',
        '**/secret.ini',
        '**/credentials',
        '**/credentials.json',
        '**/credentials.yaml',
        '**/credentials.yml',
        '**/credentials.toml',
        '**/credentials.ini',
        'node_modules/**',
        'dist/**',
        'build/**',
        'target/**',
        '.venv/**',
        'venv/**',
        '__pycache__/**',
        '**/__pycache__/**',
        '*.pyc',
        '*.pyo',
        '.noemaloom/**',
        '.agents/**',
        '.codex/**',
        '.claude/**',
        'artifacts/**',
        'artifact/**',
        'runs/**',
        'outputs/**',
        'checkpoints/**',
        'wandb/**',
        'mlruns/**',
        '**/artifacts/**',
        '**/artifact/**',
        '**/runs/**',
        '**/outputs/**',
        '**/checkpoints/**',
        '**/wandb/**',
        '**/mlruns/**',
        '**/.cache/**',
        '**/.pytest_cache/**',
        '**/.mypy_cache/**',
        'token_efficiency_benchmark/**',
        'hermes-plugin-backups/**',
        '**/hermes-plugin-backups/**',
        '**/backup/**',
        '**/backups/**',
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
      workerCommand: 'python3 -m nl_rpg_projection_worker.main',
      stateDir: '.noemaloom/planning',
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576
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
