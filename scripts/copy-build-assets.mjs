import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  {
    source: 'packages/core/src/spans/migrations/001_initial.sql',
    destination: 'packages/core/dist/spans/migrations/001_initial.sql'
  },
  {
    source: 'packages/core/src/spans/migrations/002_retrieval_core.sql',
    destination: 'packages/core/dist/spans/migrations/002_retrieval_core.sql'
  }
];

for (const asset of assets) {
  const sourcePath = path.join(repoRoot, asset.source);
  const destinationPath = path.join(repoRoot, asset.destination);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

const cliMain = path.join(repoRoot, 'packages/core/dist/cli/main.js');
if (existsSync(cliMain)) {
  const content = readFileSync(cliMain, 'utf8');
  if (!content.startsWith('#!/usr/bin/env node')) {
    writeFileSync(cliMain, `#!/usr/bin/env node\n${content}`);
  }
  chmodSync(cliMain, 0o755);
}
