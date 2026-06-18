import path from 'node:path';

import { writeFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from './state-dir.js';

export async function writeTransientBackup(input: {
  projectRoot: string;
  previousRevision?: string;
  target: string;
}): Promise<string> {
  const paths = await ensureStateDir(input.projectRoot);
  const backupPath = path.join(paths.transientDir, 'refresh-backup.json');
  await writeFileInsideStateDir(
    paths.projectRoot,
    backupPath,
    `${JSON.stringify(
      {
        previousRevision: input.previousRevision,
        target: input.target,
        createdAt: new Date(0).toISOString()
      },
      null,
      2
    )}\n`
  );
  return backupPath;
}
