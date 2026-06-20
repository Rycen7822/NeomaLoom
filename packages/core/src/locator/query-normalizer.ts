import type { FileRole } from '../spans/enums.js';
import { expandRoleAliases } from '../spans/role-groups.js';

export type NormalizedQuery = {
  raw: string;
  exactTerms: string[];
  symbolTerms: string[];
  pathTerms: string[];
  docTerms: string[];
  configTerms: string[];
  featureTerms: string[];
  oldTerms: string[];
  newTerms: string[];
  targetRoles: FileRole[];
};

const DOC_WORDS = new Set(['api', 'doc', 'docs', 'readme', 'quickstart', 'tutorial', 'guide', 'example', 'design']);
const STOP_WORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'into',
  'from',
  'to',
  'all',
  'across',
  'update',
  'change',
  'replace',
  'modify',
  'read',
  'span'
]);

const QUALIFIED_IDENTIFIER = String.raw`[A-Za-z_$][\w$-]*(?:[.:][A-Za-z_$][\w$-]*)*`;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function words(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_./:-]+/)
    .map(term => term.trim())
    .filter(Boolean);
}

function lowerWord(term: string): string {
  return term.toLowerCase();
}

function isSymbolLike(term: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(term) &&
    (/[A-Z]/.test(term.slice(1)) || term.includes('_') || term.length >= 10)
  );
}

function isPathLike(term: string): boolean {
  return term.includes('/') || /\.[A-Za-z0-9]+$/.test(term);
}

function rawPathLikeTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map(term => cleanTerm(term).replace(/^[([{<]+|[\])}>]+$/g, ''))
    .filter(term => term.length > 0 && isPathLike(term));
}

function isConfigLike(term: string): boolean {
  return /^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(term) || /^[A-Z][A-Z0-9_]{2,}$/.test(term) || /^[a-z]+(?:\.[a-z0-9_-]+)+$/.test(term);
}

function cleanTerm(term: string): string {
  return term.trim().replace(/^['"`]+|['"`.,;:]+$/g, '').replace(/\s+/g, ' ');
}

function addPair(pairs: Array<[string, string]>, oldTerm: string, newTerm: string): void {
  const oldClean = cleanTerm(oldTerm);
  const newClean = cleanTerm(newTerm);
  if (oldClean && newClean && oldClean !== newClean) {
    pairs.push([oldClean, newClean]);
  }
}

function oldNewPairs(query: string): { oldTerms: string[]; newTerms: string[] } {
  const pairs: Array<[string, string]> = [];

  for (const match of query.matchAll(new RegExp(String.raw`\bfrom\s+(${QUALIFIED_IDENTIFIER})\s+to\s+(${QUALIFIED_IDENTIFIER})`, 'gi'))) {
    addPair(pairs, match[1], match[2]);
  }
  for (const match of query.matchAll(new RegExp(String.raw`\b(?:rename|change)\s+(${QUALIFIED_IDENTIFIER})\s+to\s+(${QUALIFIED_IDENTIFIER})`, 'gi'))) {
    addPair(pairs, match[1], match[2]);
  }
  for (const match of query.matchAll(new RegExp(String.raw`(${QUALIFIED_IDENTIFIER})\s*[-=]>\s*(${QUALIFIED_IDENTIFIER})`, 'g'))) {
    addPair(pairs, match[1], match[2]);
  }
  for (const match of query.matchAll(/\breplace\s+(.+?)\s+with\s+(.+?)(?=$|\s+(?:in|across|for|and)\b)/gi)) {
    addPair(pairs, match[1], match[2]);
  }

  return {
    oldTerms: unique(pairs.map(pair => pair[0])),
    newTerms: unique(pairs.map(pair => pair[1]))
  };
}

function qualifiedIdentifierParts(term: string): string[] {
  const cleaned = cleanTerm(term);
  if (!/[.:]/.test(cleaned) || cleaned.includes('/') || /\s/.test(cleaned)) {
    return [];
  }
  return cleaned.split(/[.:]+/).filter(part => /^[A-Za-z_$][\w$]*$/.test(part));
}

function featureTermsFromConfig(configTerms: string[]): string[] {
  return configTerms
    .flatMap(term => term.replace(/^--/, '').split(/[_./-]+/))
    .map(lowerWord)
    .filter(term => term.length >= 4);
}

export function normalizeQuery(input: { query: string; targetRoles?: string[] }): NormalizedQuery {
  const raw = input.query.trim();
  const terms = words(raw);
  const cleanedTerms = terms.map(cleanTerm);
  const { oldTerms, newTerms } = oldNewPairs(raw);
  const qualifiedParts = unique([...cleanedTerms, ...oldTerms, ...newTerms].flatMap(qualifiedIdentifierParts));
  const exactTerms = unique(
    [...cleanedTerms, ...qualifiedParts]
      .map(lowerWord)
      .filter(term => term.length >= 2 && !STOP_WORDS.has(term))
  );
  const configTerms = unique(terms.filter(isConfigLike));
  const pathTerms = unique([...rawPathLikeTerms(raw), ...terms.filter(isPathLike)]);
  const symbolTerms = unique([
    ...terms.filter(isSymbolLike),
    ...oldTerms,
    ...newTerms,
    ...qualifiedParts,
    ...Array.from(raw.matchAll(/`([^`]+)`/g), match => match[1]).filter(term => /^[A-Za-z_$][\w$]*$/.test(term))
  ]);
  const docTerms = unique(exactTerms.filter(term => DOC_WORDS.has(term) || raw.toLowerCase().includes(`${term} api`)));
  const featureTerms = unique(
    [
      ...exactTerms.filter(term => !DOC_WORDS.has(term) && !STOP_WORDS.has(term) && term.length >= 4 && !pathTerms.includes(term)),
      ...featureTermsFromConfig(configTerms)
    ]
  );

  return {
    raw,
    exactTerms,
    symbolTerms,
    pathTerms,
    docTerms,
    configTerms,
    featureTerms,
    oldTerms,
    newTerms,
    targetRoles: expandRoleAliases(input.targetRoles ?? [])
  };
}
