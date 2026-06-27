import { sha1Text } from '../shared/hash.js';

export { sha1Text };

export const MAX_REPO_SPAN_INDEXED_TEXT_BYTES = 8192;
export const INDEXED_TEXT_TRUNCATION_SUFFIX = '\n…[truncated]';
const RELOCATION_FINGERPRINT_LINES = 8;

export function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function truncateIndexedText(value: string, maxBytes = MAX_REPO_SPAN_INDEXED_TEXT_BYTES): string {
  if (byteLengthUtf8(value) <= maxBytes) return value;
  const suffixBytes = byteLengthUtf8(INDEXED_TEXT_TRUNCATION_SUFFIX);
  let output = '';
  let used = 0;
  for (const char of value) {
    const charBytes = byteLengthUtf8(char);
    if (used + charBytes + suffixBytes > maxBytes) break;
    output += char;
    used += charBytes;
  }
  return `${output}${INDEXED_TEXT_TRUNCATION_SUFFIX}`;
}

function fingerprintLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trimEnd());
}

function hashLines(lines: string[]): string {
  return sha1Text(lines.join('\n'));
}

export function truncatedIndexedTextRelocationMetadata(input: {
  text: string;
  lineCount: number;
}): Record<string, unknown> {
  const lines = fingerprintLines(input.text);
  const fingerprintLineCount = Math.min(RELOCATION_FINGERPRINT_LINES, Math.max(1, lines.length));
  return {
    relocationLineCount: Math.max(1, input.lineCount),
    relocationFingerprintLineCount: fingerprintLineCount,
    relocationFirstLineHash: hashLines(lines.slice(0, 1)),
    relocationLastLineHash: hashLines(lines.slice(-1)),
    relocationPrefixHash: hashLines(lines.slice(0, fingerprintLineCount)),
    relocationSuffixHash: hashLines(lines.slice(-fingerprintLineCount))
  };
}
