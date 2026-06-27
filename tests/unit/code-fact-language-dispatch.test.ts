import { describe, expect, it } from 'vitest';

import { codeFactLanguageFamily } from '../../packages/core/src/code-fact/language-dispatch.js';

describe('code fact language dispatch', () => {
  it('maps supported languages to extractor families explicitly', () => {
    expect(codeFactLanguageFamily('typescript')).toBe('javascript_typescript');
    expect(codeFactLanguageFamily('javascript')).toBe('javascript_typescript');
    expect(codeFactLanguageFamily('python')).toBe('python');
    expect(codeFactLanguageFamily('go')).toBe('go');
    expect(codeFactLanguageFamily('rust')).toBe('rust');
    expect(codeFactLanguageFamily('java')).toBe('java_family');
    expect(codeFactLanguageFamily('kotlin')).toBe('java_family');
    expect(codeFactLanguageFamily('scala')).toBe('java_family');
    expect(codeFactLanguageFamily('markdown')).toBe('unknown');
  });
});
