import { extractTestCases } from '../../packages/core/src/tests-examples/test-case-extractor.js';

describe('test case extractor', () => {
  it('extracts Python pytest functions, classes, and markers', () => {
    const result = extractTestCases({
      path: 'tests/test_client.py',
      text: [
        'import pytest',
        '',
        '@pytest.mark.integration',
        'def test_client():',
        '    assert True',
        '',
        'class TestClient:',
        '    def test_method(self):',
        '        assert True',
        ''
      ].join('\n')
    });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'test.case',
          label: 'test_client',
          startLine: 4,
          metadata: expect.objectContaining({ markers: ['integration'] })
        }),
        expect.objectContaining({
          kind: 'test.case',
          label: 'TestClient',
          startLine: 7
        }),
        expect.objectContaining({
          kind: 'test.case',
          label: 'test_method',
          startLine: 8
        })
      ])
    );
  });

  it('extracts JS/TS, Go, Rust, and Java-family test cases', () => {
    const ts = extractTestCases({
      path: 'tests/client.test.ts',
      text: ["describe('client', () => {", "  it('creates client', () => {});", "  test('handles timeout', () => {});", '});'].join('\n')
    });
    const go = extractTestCases({
      path: 'tests/client_test.go',
      text: ['func TestClient(t *testing.T) {}', 'func BenchmarkClient(b *testing.B) {}', ''].join('\n')
    });
    const rust = extractTestCases({
      path: 'tests/client_test.rs',
      text: ['#[test]', 'fn handles_timeout() {}', ''].join('\n')
    });
    const java = extractTestCases({
      path: 'src/test/java/ClientTest.java',
      text: ['@Test', 'void handlesTimeout() {}', ''].join('\n')
    });

    expect(ts.spans.map(span => span.label)).toEqual(['client', 'creates client', 'handles timeout']);
    expect(go.spans.map(span => span.label)).toEqual(['TestClient', 'BenchmarkClient']);
    expect(rust.spans).toEqual([
      expect.objectContaining({ label: 'handles_timeout', startLine: 2 })
    ]);
    expect(java.spans).toEqual([
      expect.objectContaining({ label: 'handlesTimeout', startLine: 2 })
    ]);
  });
});
