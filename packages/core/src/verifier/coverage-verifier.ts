import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sweepOldTerms, type OldTermHit } from './old-term-sweep.js';
import { checkAnchorsAndLinks } from './anchor-checker.js';
import { checkCodeDocMismatch, type CodeDocMismatch } from './code-doc-mismatch.js';
import type { BrokenLink, StaleAnchor } from './link-checker.js';
import { classifyFileRole, isGeneratedArtifactPath } from '../files/role-classifier.js';
import { safeReadFileInsideProjectSync } from '../safety/path-guard.js';

type Statement = {
  all: (...params: unknown[]) => unknown[];
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

export type UnverifiedLinkedTest = {
  path: string;
  sourcePath: string;
  relation: 'tests';
};

export type UnsyncedDocRole = {
  path: string;
  role: string;
  term: string;
  indexed?: boolean;
};

export type CoverageVerificationResult = {
  remainingOldTermHits: OldTermHit[];
  staleAnchors: StaleAnchor[];
  brokenLinks: BrokenLink[];
  unsyncedDocRoles: UnsyncedDocRole[];
  codeDocMismatches: CodeDocMismatch[];
  unverifiedLinkedTests: UnverifiedLinkedTest[];
  unreadMustEditTargets: unknown[];
  status: 'pass' | 'needs_attention' | 'fail';
};

function statusFor(result: Omit<CoverageVerificationResult, 'status'>): CoverageVerificationResult['status'] {
  const coldUnsyncedDocs = result.unsyncedDocRoles.filter(doc => doc.indexed === false).length;
  const hardFailures =
    result.remainingOldTermHits.length +
    result.staleAnchors.length +
    result.brokenLinks.length +
    coldUnsyncedDocs +
    result.codeDocMismatches.length;
  const attention =
    result.unsyncedDocRoles.length - coldUnsyncedDocs +
    result.unverifiedLinkedTests.length +
    result.unreadMustEditTargets.length;
  if (hardFailures > 0) return 'fail';
  if (attention > 0) return 'needs_attention';
  return 'pass';
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}

function inventoryDocRolesFromSnapshot(input: {
  projectRoot: string;
  changedPaths: string[];
}): Array<{ path: string; role: string; indexed: boolean }> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(input.projectRoot, '.noemaloom', 'files', 'inventory.json'), 'utf8')) as {
      files?: Array<{ path: string }>;
    };
    const changed = new Set(input.changedPaths);
    return Array.isArray(parsed.files)
      ? parsed.files
          .filter(file => typeof file.path === 'string' && !changed.has(file.path) && !isGeneratedArtifactPath(file.path))
          .map(file => ({ path: file.path, role: classifyFileRole(file.path), indexed: false }))
          .filter(file => file.role.endsWith('_doc'))
          .sort((left, right) => left.role.localeCompare(right.role) || left.path.localeCompare(right.path))
      : [];
  } catch {
    return [];
  }
}

function readInventoryDocRoles(input: {
  projectRoot: string;
  changedPaths: string[];
}): Array<{ path: string; role: string; indexed: boolean }> {
  let db: Database | undefined;
  try {
    db = openDatabase(path.join(input.projectRoot, '.noemaloom', 'spans', 'spans.db'));
    const changed = placeholders(input.changedPaths.length > 0 ? input.changedPaths : ['']);
    return db
      .prepare(
        `SELECT DISTINCT f.path AS path, f.role AS role,
                CASE WHEN EXISTS (SELECT 1 FROM repo_spans s WHERE s.path = f.path) THEN 1 ELSE 0 END AS indexed
         FROM repo_files f
         WHERE f.role LIKE '%_doc'
           AND f.path NOT IN (${changed})
           AND f.path NOT LIKE '%/__pycache__/%'
           AND f.path NOT LIKE '%.pyc'
           AND f.path NOT LIKE '%.pyo'
         ORDER BY f.role ASC, f.path ASC`
      )
      .all(...(input.changedPaths.length > 0 ? input.changedPaths : ['']))
      .map(row => {
        const typed = row as { path: string; role: string; indexed: number };
        return { path: typed.path, role: typed.role, indexed: Boolean(typed.indexed) };
      });
  } catch {
    return inventoryDocRolesFromSnapshot(input);
  } finally {
    db?.close();
  }
}

function findUnsyncedDocRoles(input: {
  projectRoot: string;
  changedPaths: string[];
  oldTerms: string[];
}): UnsyncedDocRole[] {
  if (input.oldTerms.length === 0) {
    return [];
  }
  const hits: UnsyncedDocRole[] = [];
  for (const doc of readInventoryDocRoles(input)) {
    let text = '';
    try {
      text = safeReadFileInsideProjectSync(input.projectRoot, doc.path, 'utf8');
    } catch {
      continue;
    }
    for (const term of input.oldTerms) {
      if (!isGeneratedArtifactPath(doc.path) && term && text.includes(term)) {
        hits.push({ path: doc.path, role: doc.role, term, indexed: doc.indexed });
      }
    }
  }
  return hits;
}

function findUnverifiedLinkedTests(input: {
  projectRoot: string;
  changedPaths: string[];
}): UnverifiedLinkedTest[] {
  if (input.changedPaths.length === 0) {
    return [];
  }
  let db: Database | undefined;
  try {
    db = openDatabase(path.join(input.projectRoot, '.noemaloom', 'spans', 'spans.db'));
    const changed = placeholders(input.changedPaths);
    const rows = db
      .prepare(
        `SELECT DISTINCT test.path AS path, source.path AS sourcePath
         FROM repo_edges edge
         JOIN repo_spans test ON test.span_id = edge.source_span_id
         JOIN repo_spans source ON source.span_id = edge.target_span_id
         WHERE edge.relation = 'tests'
           AND source.path IN (${changed})
           AND test.path NOT IN (${changed})
         ORDER BY test.path ASC, source.path ASC`
      )
      .all(...input.changedPaths, ...input.changedPaths) as Array<{ path: string; sourcePath: string }>;
    return rows.map(row => ({ path: row.path, sourcePath: row.sourcePath, relation: 'tests' as const }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function verifyCoverage(input: {
  projectRoot: string;
  goal: string;
  changedPaths: string[];
  oldTerms?: string[];
  newTerms?: string[];
}): Promise<CoverageVerificationResult> {
  const oldTerms = input.oldTerms ?? [];
  const newTerms = input.newTerms ?? [];
  const remainingOldTermHits = await sweepOldTerms({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths,
    oldTerms
  });
  const links = await checkAnchorsAndLinks({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths
  });
  const codeDocMismatches = await checkCodeDocMismatch({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths,
    newTerms
  });
  const unverifiedLinkedTests = findUnverifiedLinkedTests({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths
  });
  const unsyncedDocRoles = findUnsyncedDocRoles({
    projectRoot: input.projectRoot,
    changedPaths: input.changedPaths,
    oldTerms
  });
  const withoutStatus = {
    remainingOldTermHits,
    staleAnchors: links.staleAnchors,
    brokenLinks: links.brokenLinks,
    unsyncedDocRoles,
    codeDocMismatches,
    unverifiedLinkedTests,
    unreadMustEditTargets: []
  };
  return {
    ...withoutStatus,
    status: statusFor(withoutStatus)
  };
}
