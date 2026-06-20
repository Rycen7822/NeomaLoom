import { applyExactRoute, planExactRoute } from '../../packages/core/src/mcp/exact-route.js';

const targets = [
  {
    spanId: 'source-exact',
    path: 'v2h/tools/train_g8_ddp.py',
    kind: 'code.module',
    label: 'train_g8_ddp'
  },
  {
    spanId: 'same-basename',
    path: 'v2/tools/train_g8_ddp.py',
    kind: 'code.module',
    label: 'train_g8_ddp'
  },
  {
    spanId: 'route-method',
    path: 'v2h/models/h1_rectifier.py',
    kind: 'code.method',
    label: '_route_weights'
  }
];

describe('exact route planner', () => {
  it('routes a covered explicit relative path to exact_path and filters same-basename matches', () => {
    const route = planExactRoute({
      normalizedQuery: {
        pathTerms: ['v2h/tools/train_g8_ddp.py'],
        symbolTerms: [],
        targetRoles: ['source_file']
      },
      targets
    });

    expect(route).toMatchObject({
      route: 'exact_path',
      confidence: expect.any(Number),
      coveredPaths: ['v2h/tools/train_g8_ddp.py'],
      uncoveredPaths: [],
      fallbackReason: null
    });
    expect(applyExactRoute(targets, route).map(target => target.spanId)).toEqual(['source-exact']);
  });

  it('falls back to ranked context when an explicit path is not covered', () => {
    const route = planExactRoute({
      normalizedQuery: {
        pathTerms: ['docs/missing.md'],
        symbolTerms: [],
        targetRoles: ['design_doc']
      },
      targets
    });

    expect(route).toMatchObject({
      route: 'noemaloom_rank',
      fallbackReason: 'explicit_path_not_covered',
      uncoveredPaths: ['docs/missing.md']
    });
    expect(applyExactRoute(targets, route)).toEqual(targets);
  });

  it('routes a unique declaration symbol but falls back when symbols are ambiguous', () => {
    const unique = planExactRoute({
      normalizedQuery: { symbolTerms: ['_route_weights'], pathTerms: [] },
      targets
    });
    expect(unique).toMatchObject({ route: 'exact_symbol', targetSpanIds: ['route-method'] });

    const ambiguous = planExactRoute({
      normalizedQuery: { symbolTerms: ['_route_weights'], pathTerms: [] },
      targets: [
        ...targets,
        {
          spanId: 'route-method-alt',
          path: 'v2/models/h1_rectifier.py',
          kind: 'code.method',
          label: '_route_weights'
        }
      ]
    });
    expect(ambiguous).toMatchObject({ route: 'noemaloom_rank', fallbackReason: 'ambiguous_symbol' });
  });
});
