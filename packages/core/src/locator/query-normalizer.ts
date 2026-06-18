import type { FileRole } from '../spans/enums.js';

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
  'modify',
  'read',
  'span'
]);

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

function isConfigLike(term: string): boolean {
  return /^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(term) || /^[A-Z][A-Z0-9_]{2,}$/.test(term) || /^[a-z]+(?:\.[a-z0-9_-]+)+$/.test(term);
}

function oldNewPairs(query: string): { oldTerms: string[]; newTerms: string[] } {
  const pairs: Array<[string, string]> = [];

  for (const match of query.matchAll(/\bfrom\s+([A-Za-z_$][\w$-]*)\s+to\s+([A-Za-z_$][\w$-]*)/gi)) {
    pairs.push([match[1], match[2]]);
  }
  for (const match of query.matchAll(/\brename\s+([A-Za-z_$][\w$-]*)\s+to\s+([A-Za-z_$][\w$-]*)/gi)) {
    pairs.push([match[1], match[2]]);
  }
  for (const match of query.matchAll(/([A-Za-z_$][\w$-]*)\s*[-=]>\s*([A-Za-z_$][\w$-]*)/g)) {
    pairs.push([match[1], match[2]]);
  }

  return {
    oldTerms: unique(pairs.map(pair => pair[0])),
    newTerms: unique(pairs.map(pair => pair[1]))
  };
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
  const exactTerms = unique(
    terms
      .map(term => term.replace(/^`|`$/g, ''))
      .map(lowerWord)
      .filter(term => term.length >= 2 && !STOP_WORDS.has(term))
  );
  const configTerms = unique(terms.filter(isConfigLike));
  const pathTerms = unique(terms.filter(isPathLike));
  const { oldTerms, newTerms } = oldNewPairs(raw);
  const symbolTerms = unique([
    ...terms.filter(isSymbolLike),
    ...oldTerms,
    ...newTerms,
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
    targetRoles: unique((input.targetRoles ?? []) as FileRole[])
  };
}
