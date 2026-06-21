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
        signature: expect.stringContaining('_route_weights('),
        boundaryMethod: 'python_indent',
        boundaryComplete: true
      }
    });
    expect(method?.text).toContain('topk: int');
    expect(method?.text).toContain('return weights');

    const functionSpan = result.spans.find(span => span.kind === 'code.function' && span.label === 'evaluate_loader_ddp');
    expect(functionSpan).toMatchObject({ startLine: 11, endLine: 14 });
  });

  it('indexes TypeScript declarations with full block boundaries and boundary metadata', () => {
    const text = [
      'export function runTask(task: Task) {',
      '  const object = { value: "}" };',
      '  return schedule(task);',
      '}',
      '',
      'export class Scheduler {',
      '  schedule(task: Task): string {',
      '    return runTask(task);',
      '  }',
      '}',
      '',
      'export function afterClass() {',
      '  return "after";',
      '}'
    ].join('\n');

    const result = extractCodeFacts({ projectRoot: '/repo', path: 'src/scheduler.ts', language: 'typescript', text });
    const functionSpan = result.spans.find(span => span.kind === 'code.function' && span.label === 'runTask');
    expect(functionSpan).toMatchObject({
      startLine: 1,
      endLine: 4,
      metadata: {
        boundaryMethod: 'typescript_brace',
        boundaryComplete: true,
        boundaryReason: 'balanced_braces'
      }
    });
    expect(functionSpan?.text).toContain('return schedule(task);');

    const method = result.spans.find(span => span.kind === 'code.method' && span.label === 'schedule');
    expect(method).toMatchObject({
      startLine: 7,
      endLine: 9,
      metadata: { className: 'Scheduler', qualifiedName: 'src/scheduler.ts:Scheduler.schedule' }
    });

    const afterClass = result.spans.find(span => span.kind === 'code.function' && span.label === 'afterClass');
    expect(afterClass).toMatchObject({ startLine: 12, endLine: 14, metadata: { qualifiedName: 'src/scheduler.ts:afterClass' } });
  });

  it('bounds callsite extraction per file and skips pathological long lines', () => {
    const repeatedCalls = Array.from({ length: 1200 }, (_, index) => `call${index}()`).join('\n');
    const longLine = `${'x'.repeat(20001)} afterLongLine()`;
    const result = extractCodeFacts({
      projectRoot: '/repo',
      path: 'src/noisy.ts',
      language: 'typescript',
      text: `${repeatedCalls}\n${longLine}`
    });

    const callsites = result.spans.filter(span => span.kind === 'code.callsite');
    expect(callsites).toHaveLength(1000);
    expect(callsites.some(span => span.label === 'afterLongLine')).toBe(false);
  });
});
