export type RequiredVerificationSource = 'impact' | 'coverage_plan' | 'coverage_gap' | 'heuristic';

export type RequiredVerificationItem = {
  path: string;
  source: RequiredVerificationSource;
  reason: string;
  severity: 'required' | 'needs_attention';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function pushUnique(items: RequiredVerificationItem[], next: RequiredVerificationItem): void {
  const existing = items.find(item => item.path === next.path && item.source === next.source);
  if (!existing) {
    items.push(next);
  }
}

export function mergeRequiredVerification(input: {
  impactRequiredVerification?: unknown;
  coveragePlan?: unknown;
  coverage?: unknown;
}): RequiredVerificationItem[] {
  const items: RequiredVerificationItem[] = [];

  for (const path of stringArray(input.impactRequiredVerification)) {
    pushUnique(items, { path, source: 'impact', reason: 'impact trace requires verification', severity: 'required' });
  }

  if (isRecord(input.coveragePlan)) {
    for (const path of stringArray(input.coveragePlan.linkedTestsToVerify)) {
      pushUnique(items, { path, source: 'coverage_plan', reason: 'linked test surfaced by coverage plan', severity: 'required' });
    }
    for (const path of stringArray(input.coveragePlan.linkedDocsToVerify)) {
      pushUnique(items, { path, source: 'coverage_plan', reason: 'linked doc surfaced by coverage plan', severity: 'needs_attention' });
    }
  }

  if (isRecord(input.coverage)) {
    const linkedTests = Array.isArray(input.coverage.unverifiedLinkedTests) ? input.coverage.unverifiedLinkedTests : [];
    for (const test of linkedTests) {
      if (!isRecord(test) || typeof test.path !== 'string') continue;
      pushUnique(items, {
        path: test.path,
        source: test.source === 'heuristic' ? 'heuristic' : 'coverage_gap',
        reason: 'linked test has not been verified after changed source',
        severity: 'required'
      });
    }
    const docs = Array.isArray(input.coverage.unsyncedDocRoles) ? input.coverage.unsyncedDocRoles : [];
    for (const doc of docs) {
      if (!isRecord(doc) || typeof doc.path !== 'string') continue;
      pushUnique(items, {
        path: doc.path,
        source: 'coverage_gap',
        reason: 'doc still contains an old term outside the changed path set',
        severity: doc.severity === 'fail' ? 'required' : 'needs_attention'
      });
    }
  }

  return items.sort((left, right) =>
    (left.severity === right.severity ? 0 : left.severity === 'required' ? -1 : 1) ||
    left.path.localeCompare(right.path) ||
    left.source.localeCompare(right.source)
  );
}

export function requiredVerificationPaths(items: RequiredVerificationItem[]): string[] {
  return [...new Set(items.filter(item => item.severity === 'required').map(item => item.path))].sort();
}
