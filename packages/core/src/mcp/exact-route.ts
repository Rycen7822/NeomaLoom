type RouteTarget = {
  spanId: string;
  path: string;
  kind: string;
  label: string;
  decision?: string;
  indexed?: boolean;
};

type RouteQuery = {
  pathTerms?: string[];
  symbolTerms?: string[];
  targetRoles?: string[];
};

export type ExactRoutePlan = {
  route: 'exact_path' | 'exact_symbol' | 'exact_multisurface' | 'noemaloom_rank';
  confidence: number;
  signals: string[];
  coveredPaths: string[];
  uncoveredPaths: string[];
  targetSpanIds: string[];
  fallbackReason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedPathTerm(term: string): string {
  return term.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function isExplicitPathTerm(term: string): boolean {
  return term.includes('/') || /\.[A-Za-z0-9]+$/.test(term);
}

function pathMatchesTerm(path: string, term: string): boolean {
  const candidatePath = path.toLowerCase();
  const normalized = normalizedPathTerm(term);
  return candidatePath === normalized || candidatePath.endsWith(`/${normalized}`);
}

function declarationKind(kind: string): boolean {
  return ['code.function', 'code.method', 'code.class', 'code.constant', 'code.component'].includes(kind);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function planExactRoute(input: { normalizedQuery: unknown; targets: RouteTarget[] }): ExactRoutePlan {
  const query = isRecord(input.normalizedQuery) ? input.normalizedQuery as RouteQuery : {};
  const pathTerms = [...new Set(stringArray(query.pathTerms).filter(isExplicitPathTerm))];
  const broadTargetRoles = stringArray(query.targetRoles).filter(role => !['unknown'].includes(role));

  if (pathTerms.length > 0) {
    const coveredPaths: string[] = [];
    const uncoveredPaths: string[] = [];
    const targetSpanIds = new Set<string>();

    for (const term of pathTerms) {
      const matches = input.targets.filter(target => pathMatchesTerm(target.path, term));
      if (matches.length === 0) {
        uncoveredPaths.push(term);
      } else {
        coveredPaths.push(term);
        for (const match of matches) {
          targetSpanIds.add(match.spanId);
        }
      }
    }

    if (uncoveredPaths.length > 0) {
      return {
        route: 'noemaloom_rank',
        confidence: 0.4,
        signals: ['path'],
        coveredPaths,
        uncoveredPaths,
        targetSpanIds: [],
        fallbackReason: 'explicit_path_not_covered'
      };
    }

    if (broadTargetRoles.length > 1 && pathTerms.length < broadTargetRoles.length) {
      return {
        route: 'noemaloom_rank',
        confidence: 0.5,
        signals: ['path', 'target_roles'],
        coveredPaths,
        uncoveredPaths,
        targetSpanIds: [],
        fallbackReason: 'multi_role_query_needs_ranked_context'
      };
    }

    return {
      route: pathTerms.length > 1 ? 'exact_multisurface' : 'exact_path',
      confidence: pathTerms.length > 1 ? 0.9 : 0.94,
      signals: ['path'],
      coveredPaths,
      uncoveredPaths,
      targetSpanIds: [...targetSpanIds],
      fallbackReason: null
    };
  }

  const symbolTerms = stringArray(query.symbolTerms);
  if (broadTargetRoles.length > 1) {
    return {
      route: 'noemaloom_rank',
      confidence: 0.5,
      signals: ['symbol', 'target_roles'],
      coveredPaths: [],
      uncoveredPaths: [],
      targetSpanIds: [],
      fallbackReason: 'multi_role_query_needs_ranked_context'
    };
  }
  const symbolMatches = input.targets.filter(target =>
    declarationKind(target.kind) && symbolTerms.some(symbol => target.label === symbol)
  );
  const uniqueSymbols = new Set(symbolMatches.map(target => target.label));
  if (symbolMatches.length === 1 && uniqueSymbols.size === 1) {
    return {
      route: 'exact_symbol',
      confidence: 0.86,
      signals: ['symbol'],
      coveredPaths: [symbolMatches[0].path],
      uncoveredPaths: [],
      targetSpanIds: [symbolMatches[0].spanId],
      fallbackReason: null
    };
  }

  return {
    route: 'noemaloom_rank',
    confidence: 0.3,
    signals: [],
    coveredPaths: [],
    uncoveredPaths: [],
    targetSpanIds: [],
    fallbackReason: symbolMatches.length > 1 ? 'ambiguous_symbol' : 'no_exact_signal'
  };
}

export function applyExactRoute<T extends RouteTarget>(targets: T[], route: ExactRoutePlan): T[] {
  if (route.route === 'noemaloom_rank' || route.targetSpanIds.length === 0) {
    return targets;
  }
  const selected = new Set(route.targetSpanIds);
  return targets.filter(target => selected.has(target.spanId));
}
