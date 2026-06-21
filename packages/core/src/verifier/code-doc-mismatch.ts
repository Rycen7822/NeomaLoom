import { safeReadFileInsideProject } from '../safety/path-guard.js';

export type CodeDocMismatch = {
  path: string;
  reason: string;
};

export async function checkCodeDocMismatch(input: {
  projectRoot: string;
  changedPaths: string[];
  newTerms: string[];
}): Promise<CodeDocMismatch[]> {
  if (input.newTerms.length === 0) {
    return [];
  }
  const mismatches: CodeDocMismatch[] = [];
  for (const changedPath of input.changedPaths.filter(file => /\.(md|mdx|rst)$/i.test(file))) {
    let text = '';
    try {
      text = await safeReadFileInsideProject(input.projectRoot, changedPath, 'utf8');
    } catch {
      continue;
    }
    if (!input.newTerms.some(term => text.includes(term))) {
      mismatches.push({ path: changedPath, reason: `changed doc does not mention new terms: ${input.newTerms.join(', ')}` });
    }
  }
  return mismatches;
}
