export type RedactionKind =
  | 'api_key'
  | 'token'
  | 'secret'
  | 'password'
  | 'aws_access_key'
  | 'private_key'
  | 'jwt'
  | 'email';

export type RedactionResult = {
  redactedText: string;
  hasSensitiveContent: boolean;
  redactedKinds: RedactionKind[];
};

type RedactionPattern = {
  kind: RedactionKind;
  pattern: RegExp;
  shouldScan?: (input: string) => boolean;
};

const PATTERNS: RedactionPattern[] = [
  { kind: 'api_key', pattern: /["']?api[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi },
  { kind: 'token', pattern: /["']?(?:token|bearer|authorization)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.]{32,})["']?/gi },
  { kind: 'secret', pattern: /["']?secret["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.]{16,})["']?/gi },
  { kind: 'password', pattern: /["']?(?:password|passwd|pwd)["']?\s*[:=]\s*(?:"[^"\r\n]{8,256}"|'[^'\r\n]{8,256}'|[^"'\s]{8,128})/gi },
  { kind: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { kind: 'email', pattern: /[a-zA-Z0-9._%+\-]{1,128}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,63}/g, shouldScan: input => input.includes('@') }
];

function cloneRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function pushKind(kinds: RedactionKind[], kind: RedactionKind): void {
  if (!kinds.includes(kind)) {
    kinds.push(kind);
  }
}

export function redactText(input: string, enabledKinds?: RedactionKind[]): RedactionResult {
  if (input.length === 0) {
    return { redactedText: input, hasSensitiveContent: false, redactedKinds: [] };
  }
  const enabled = enabledKinds ? new Set(enabledKinds) : undefined;
  let redactedText = input;
  const redactedKinds: RedactionKind[] = [];

  for (const { kind, pattern, shouldScan } of PATTERNS) {
    if (enabled && !enabled.has(kind)) {
      continue;
    }
    if (shouldScan && !shouldScan(redactedText)) {
      continue;
    }
    const detector = cloneRegex(pattern);
    const matches = redactedText.match(detector);
    if (!matches || matches.length === 0) {
      continue;
    }
    pushKind(redactedKinds, kind);
    redactedText = redactedText.replace(cloneRegex(pattern), `[REDACTED:${kind}]`);
  }

  return {
    redactedText,
    hasSensitiveContent: redactedKinds.length > 0,
    redactedKinds
  };
}
