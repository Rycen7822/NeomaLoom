import { applyLocatorTokenBudget, estimateEnvelopeTokenBudget } from '../../packages/core/src/mcp/token-budget.js';

describe('locator token budget', () => {
  it('preserves must_edit targets and coverage warnings while truncating inspect_only targets first', () => {
    const result = applyLocatorTokenBudget({
      requested: 80,
      targets: [
        {
          spanId: 'must-doc',
          decision: 'must_edit',
          role: 'canonical_api_doc',
          path: 'docs/api/client.md',
          estimatedTokens: 42
        },
        {
          spanId: 'inspect-readme',
          decision: 'inspect_only',
          role: 'readme_doc',
          path: 'README.md',
          estimatedTokens: 32
        },
        {
          spanId: 'inspect-example',
          decision: 'inspect_only',
          role: 'example_doc',
          path: 'examples/client.md',
          estimatedTokens: 32
        },
        {
          spanId: 'verify-test',
          decision: 'verify_only',
          role: 'test_file',
          path: 'tests/client.test.ts',
          estimatedTokens: 18
        }
      ],
      warnings: [
        {
          code: 'coverage_missing',
          severity: 'warning',
          message: 'readme_doc exists and must be verified'
        }
      ]
    });

    expect(result.targets.map(target => target.spanId)).toEqual(['must-doc', 'verify-test']);
    expect(result.tokenBudget).toEqual({ requested: 80, used: 80, truncated: true });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'coverage_missing' }),
        expect.objectContaining({
          code: 'token_budget_truncated',
          message: expect.stringContaining('omitted target count: 2')
        }),
        expect.objectContaining({
          code: 'token_budget_truncated',
          message: expect.stringContaining('omitted roles: example_doc, readme_doc')
        })
      ])
    );
  });

  it('marks final shaped output over-budget instead of reporting a false non-truncated envelope', () => {
    const result = estimateEnvelopeTokenBudget({
      requested: 10,
      data: { payload: 'x'.repeat(200) },
      evidence: [],
      warnings: [],
      nextActions: ['inspect the compact warning']
    });

    expect(result.tokenBudget.requested).toBe(10);
    expect(result.tokenBudget.used).toBeGreaterThan(10);
    expect(result.tokenBudget.truncated).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'output_budget_exceeded' })
    ]));
  });
});
