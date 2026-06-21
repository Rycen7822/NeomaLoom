import { redactText } from '../../packages/core/src/safety/redaction.js';

describe('redaction safety helper', () => {
  it('redacts supported secret-like patterns and preserves kind order', () => {
    const input = [
      'api_key = "abcdefghijklmnop1234567890"',
      'token: abcdefghijklmnopqrstuvwxyzABCDEF123456',
      'secret = "supersecretvalue123456"',
      'password: hunter2secure',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      '-----BEGIN ' + 'PRIVATE KEY-----\nabc\n-----END ' + 'PRIVATE KEY-----',
      'eyJabc.eyJdef.signature',
      'user@example.com',
      '10.20.30.40'
    ].join('\n');

    const result = redactText(input);

    expect(result.hasSensitiveContent).toBe(true);
    expect(result.redactedKinds).toEqual([
      'api_key',
      'token',
      'secret',
      'password',
      'aws_access_key',
      'private_key',
      'jwt',
      'email',
      'ipv4'
    ]);
    expect(result.redactedText).toContain('[REDACTED:api_key]');
    expect(result.redactedText).toContain('[REDACTED:token]');
    expect(result.redactedText).toContain('[REDACTED:private_key]');
    expect(result.redactedText).not.toContain('abcdefghijklmnop1234567890');
    expect(result.redactedText).not.toContain('user@example.com');
    expect(result.redactedText).not.toContain('10.20.30.40');
  });

  it('returns original text when no patterns match', () => {
    const input = 'ordinary documentation with no credentials';
    expect(redactText(input)).toEqual({
      redactedText: input,
      hasSensitiveContent: false,
      redactedKinds: []
    });
  });

  it('does not miss repeated matches because of global RegExp state', () => {
    const first = redactText('api_key = firstabcdefghijklmnop');
    const second = redactText('api_key = secondabcdefghijklmnop');
    expect(first.redactedKinds).toEqual(['api_key']);
    expect(second.redactedKinds).toEqual(['api_key']);
    expect(second.redactedText).toContain('[REDACTED:api_key]');
  });

  it('redacts quoted JSON and object-style secret keys', () => {
    const input = '{"api_key": "abcdefghijklmnop1234567890", "password": "hunter2secure"}';

    const result = redactText(input);

    expect(result.hasSensitiveContent).toBe(true);
    expect(result.redactedKinds).toEqual(['api_key', 'password']);
    expect(result.redactedText).not.toContain('abcdefghijklmnop1234567890');
    expect(result.redactedText).not.toContain('hunter2secure');
  });

  it('redacts quoted passphrases with spaces and gates email scanning behind @', () => {
    const noEmail = redactText('ordinary release notes '.repeat(2000));
    expect(noEmail.redactedKinds).not.toContain('email');

    const result = redactText('password = "correct horse battery staple" and owner admin@example.com');
    expect(result.redactedKinds).toEqual(['password', 'email']);
    expect(result.redactedText).toContain('[REDACTED:password]');
    expect(result.redactedText).not.toContain('correct horse battery staple');
    expect(result.redactedText).not.toContain('admin@example.com');
  });
});
