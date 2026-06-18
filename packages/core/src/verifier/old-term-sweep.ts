import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type OldTermHit = {
  path: string;
  line: number;
  term: string;
  text: string;
};

export async function sweepOldTerms(input: {
  projectRoot: string;
  changedPaths: string[];
  oldTerms: string[];
}): Promise<OldTermHit[]> {
  const hits: OldTermHit[] = [];
  for (const changedPath of input.changedPaths) {
    const text = await readFile(path.join(input.projectRoot, changedPath), 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const term of input.oldTerms) {
        if (term && line.includes(term)) {
          hits.push({ path: changedPath, line: index + 1, term, text: line.trim() });
        }
      }
    });
  }
  return hits;
}
