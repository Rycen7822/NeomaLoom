import path from 'node:path';

import { buildFileInventory, type FileInventory, type InventoryFile } from '../files/file-inventory.js';
import { safeReadFileInsideProject } from '../safety/path-guard.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import { detectCodeLanguage, isCodeFactLanguage } from './language-detect.js';
import { writeCodeGraphDb, searchCodeGraphDb, type CodeFactSearchResult } from './codegraph-db.js';
import { extractCodeFacts, type CodeFactEdge, type CodeFactSpan } from './extractor.js';
import { projectCodeFacts } from './projector.js';
import { resolveCodeFactEdges } from './reference-resolver.js';

export type CodeFactTextProvider = (file: InventoryFile) => Promise<string>;

export type IndexCodeFactsInput = {
  projectRoot: string;
  inventory?: FileInventory;
  includeExperimentNotes?: boolean;
  includeVendor?: boolean;
  textForFile?: CodeFactTextProvider;
  writeDb?: boolean;
};

export type IndexCodeFactsResult = {
  dbPath: string;
  spans: CodeFactSpan[];
  edges: CodeFactEdge[];
};

const CODE_FACT_INDEX_CONCURRENCY = 8;

async function indexedTextForFile(projectRoot: string, file: InventoryFile): Promise<string> {
  if (file.oversized) {
    return '';
  }
  return file.indexedText !== '' || file.sizeBytes === 0 ? file.indexedText : safeReadFileInsideProject(projectRoot, file.path, 'utf8');
}

export async function indexCodeFacts(input: IndexCodeFactsInput): Promise<IndexCodeFactsResult> {
  const inventory = input.inventory ?? (await buildFileInventory({ projectRoot: input.projectRoot, loadIndexedText: false }));
  const codeFiles = inventory.files
    .map(file => ({
      ...file,
      language: detectCodeLanguage(file.path)
    }))
    .filter(
      file =>
        !file.oversized &&
        (input.includeExperimentNotes || file.role !== 'experiment_note_doc') &&
        file.role !== 'generated_file' &&
        (input.includeVendor || file.role !== 'vendor_file') &&
        isCodeFactLanguage(file.language)
    );
  const textForFile = input.textForFile ?? ((file: InventoryFile) => indexedTextForFile(input.projectRoot, file));
  const spanGroups = await mapWithConcurrency(
    codeFiles,
    CODE_FACT_INDEX_CONCURRENCY,
    async file =>
      extractCodeFacts({
        projectRoot: input.projectRoot,
        path: file.path,
        language: file.language,
        text: await textForFile(file)
      }).spans
  );
  const spans = spanGroups.flat();
  const edges = resolveCodeFactEdges(spans);
  const projected = projectCodeFacts({ spans, edges });
  const dbPath = input.writeDb === false
    ? path.join(input.projectRoot, '.noemaloom', 'fact', 'codegraph.db')
    : await writeCodeGraphDb({
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
