import { classifyPathLayer } from '../files/path-layer.js';
import { boundedCollectChangedPathFiles } from '../files/bounded-changed-paths.js';
import { safeReadFileInsideProject } from '../safety/path-guard.js';

export type OldTermHit = {
  path: string;
  line: number;
  term: string;
  text: string;
  pathLayer: string;
  severity: 'fail';
};

export async function sweepOldTerms(input: {
  projectRoot: string;
  changedPaths: string[];
  oldTerms: string[];
}): Promise<OldTermHit[]> {
  const hits: OldTermHit[] = [];
  const expandedPaths = (await boundedCollectChangedPathFiles({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths,
    textOnly: true
  })).files;
  for (const changedPath of expandedPaths) {
    let text = '';
    try {
      text = await safeReadFileInsideProject(input.projectRoot, changedPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const term of input.oldTerms) {
        if (term && line.includes(term)) {
          hits.push({ path: changedPath, line: index + 1, term, text: line.trim(), pathLayer: classifyPathLayer(changedPath), severity: 'fail' });
        }
      }
    });
  }
  return hits;
}
