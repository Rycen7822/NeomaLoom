import { extractCodeFacts } from '../../packages/core/src/code-fact/extractor.js';

describe('code fact extractor', () => {
  it('indexes multiline private Python methods with class-qualified names and body ranges', () => {
    const text = [
      'class H1SpectralMoERectifier:',
      '    def _route_weights(',
      '        self,',
      '        *,',
      '        logits,',
      '        topk: int,',
      '    ) -> torch.Tensor:',
      '        weights = logits.softmax(dim=-1)',
      '        return weights[:, :topk]',
      '',
      'def evaluate_loader_ddp(',
      '    loader,',
      ') -> float:',
      '    return 1.0',
      ''
    ].join('\n');

    const result = extractCodeFacts({
      projectRoot: '/repo',
      path: 'v2h/models/h1_rectifier.py',
      language: 'python',
      text
    });

    const method = result.spans.find(span => span.kind === 'code.method' && span.label === '_route_weights');
    expect(method).toMatchObject({
      path: 'v2h/models/h1_rectifier.py',
      startLine: 2,
      endLine: 9,
      metadata: {
        qualifiedName: 'v2h/models/h1_rectifier.py:H1SpectralMoERectifier._route_weights',
        className: 'H1SpectralMoERectifier',
        signature: expect.stringContaining('_route_weights(')
      }
    });
    expect(method?.text).toContain('topk: int');
    expect(method?.text).toContain('return weights');

    const functionSpan = result.spans.find(span => span.kind === 'code.function' && span.label === 'evaluate_loader_ddp');
    expect(functionSpan).toMatchObject({ startLine: 11, endLine: 14 });
  });
});
