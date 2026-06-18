import { getHelpText } from '../../packages/core/src/cli/help.js';

describe('noemaloom CLI help', () => {
  it('lists only the supported serve command and no installer or writer commands', () => {
    const help = getHelpText();

    expect(help).toContain('Usage: noemaloom serve --mcp');
    expect(help).toContain('NoemaLoom locates and verifies repository spans.');

    for (const forbiddenCommand of [
      'install',
      'uninstall',
      'init',
      'agent',
      'hook',
      'writer',
      'codegen',
      'write-codex-config',
      'write-hermes-config'
    ]) {
      expect(help).not.toContain(forbiddenCommand);
    }
  });
});
