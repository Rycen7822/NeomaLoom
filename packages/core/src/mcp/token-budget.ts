import type { EnvelopeWarning, TokenBudget } from './envelope.js';

type BudgetedTarget = {
  decision?: string;
  role?: string;
  estimatedTokens?: number;
};

export type BudgetResult<T extends BudgetedTarget> = {
  targets: T[];
  warnings: EnvelopeWarning[];
  tokenBudget: TokenBudget;
};

function estimateTokens(target: BudgetedTarget): number {
  if (typeof target.estimatedTokens === 'number' && Number.isFinite(target.estimatedTokens)) {
    return Math.max(0, Math.ceil(target.estimatedTokens));
  }
  return Math.ceil(JSON.stringify(target).length / 4);
}

function priority(target: BudgetedTarget): number {
  if (target.decision === 'must_edit') return 0;
  if (target.decision === 'verify_only') return 1;
  if (target.decision === 'maybe_edit') return 2;
  if (target.decision === 'inspect_only') return 3;
  return 2;
}

export function applyLocatorTokenBudget<T extends BudgetedTarget>(input: {
  requested: number;
  targets: T[];
  warnings?: EnvelopeWarning[];
}): BudgetResult<T> {
  const requested = Math.max(0, Math.floor(input.requested));
  const warnings = [...(input.warnings ?? [])];
  const indexedTargets = input.targets.map((target, index) => ({ target, index, tokens: estimateTokens(target) }));
  const sorted = [...indexedTargets].sort((left, right) => priority(left.target) - priority(right.target) || left.index - right.index);
  const kept = new Set<number>();
  let used = 0;

  for (const item of sorted) {
    const shouldAlwaysKeepFirst = kept.size === 0;
    if (shouldAlwaysKeepFirst || used + item.tokens <= requested) {
      kept.add(item.index);
      used += item.tokens;
    }
  }

  const targets = indexedTargets.filter(item => kept.has(item.index)).sort((left, right) => left.index - right.index).map(item => item.target);
  const omitted = indexedTargets.filter(item => !kept.has(item.index));

  if (omitted.length > 0) {
    const omittedRoles = [...new Set(omitted.map(item => item.target.role).filter((role): role is string => typeof role === 'string'))].sort();
    warnings.push(
      {
        code: 'token_budget_truncated',
        severity: 'warning',
        message: `omitted target count: ${omitted.length}`
      },
      {
        code: 'token_budget_truncated',
        severity: 'warning',
        message: `omitted roles: ${omittedRoles.join(', ')}`
      }
    );
  }

  return {
    targets,
    warnings,
    tokenBudget: {
      requested,
      used,
      truncated: omitted.length > 0
    }
  };
}

export function estimateEnvelopeTokenBudget(input: {
  requested: number;
  data: unknown;
  evidence?: unknown[];
  warnings?: EnvelopeWarning[];
  nextActions?: string[];
  truncated?: boolean;
}): { tokenBudget: TokenBudget; warnings: EnvelopeWarning[] } {
  const requested = Math.max(0, Math.floor(input.requested));
  const warnings = [...(input.warnings ?? [])];
  const used = Math.ceil(JSON.stringify({
    data: input.data,
    evidence: input.evidence ?? [],
    warnings,
    nextActions: input.nextActions ?? []
  }).length / 4);
  if (used > requested) {
    warnings.push({
      code: 'output_budget_exceeded',
      severity: 'warning',
      message: `final shaped output estimate ${used} exceeds requested budget ${requested}`
    });
  }
  return {
    tokenBudget: {
      requested,
      used,
      truncated: Boolean(input.truncated) || used > requested
    },
    warnings
  };
}
