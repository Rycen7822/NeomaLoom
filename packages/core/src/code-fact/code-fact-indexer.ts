import { buildFileInventory } from '../files/file-inventory.js';
import { detectCodeLanguage, isCodeFactLanguage } from './language-detect.js';
import { writeCodeGraphDb, searchCodeGraphDb, type CodeFactSearchResult } from './codegraph-db.js';
import { extractCodeFacts, type CodeFactEdge, type CodeFactSpan } from './extractor.js';
import { projectCodeFacts } from './projector.js';
import { resolveCodeFactEdges } from './reference-resolver.js';

export type IndexCodeFactsInput = {
  projectRoot: string;
};

export type IndexCodeFactsResult = {
  dbPath: string;
  spans: CodeFactSpan[];
  edges: CodeFactEdge[];
};

export async function indexCodeFacts(input: IndexCodeFactsInput): Promise<IndexCodeFactsResult> {
  const inventory = await buildFileInventory({ projectRoot: input.projectRoot });
  const codeFiles = inventory.files
    .map(file => ({
      ...file,
      language: detectCodeLanguage(file.path)
    }))
    .filter(file => !file.oversized && isCodeFactLanguage(file.language));
  const spans = codeFiles.flatMap(file =>
    extractCodeFacts({
      projectRoot: input.projectRoot,
      path: file.path,
      language: file.language,
      text: file.indexedText
    }).spans
  );
  const edges = resolveCodeFactEdges(spans);
  const projected = projectCodeFacts({ spans, edges });
  const dbPath = await writeCodeGraphDb({
    projectRoot: input.projectRoot,
    files: codeFiles.map(file => ({ path: file.path, language: file.language })),
    spans: projected.spans,
    edges: projected.edges
  });

  return {
    dbPath,
    spans: projected.spans,
    edges: projected.edges
  };
}

export function searchCodeFacts(input: { dbPath: string; query: string; limit?: number }): CodeFactSearchResult[] {
  return searchCodeGraphDb(input);
}

export type { CodeFactEdge, CodeFactSpan } from './extractor.js';
