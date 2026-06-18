import { fileURLToPath } from 'node:url';

import { serveMcp } from '../mcp/server.js';
import { getHelpText } from './help.js';

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

export async function runCli(argv = process.argv.slice(2), io = defaultIo): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (argv.length === 2 && argv[0] === 'serve' && argv[1] === '--mcp') {
    await serveMcp();
    return 0;
  }

  io.stderr.write(`Unknown command.\n\n${getHelpText()}\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().then(
    exitCode => {
      process.exitCode = exitCode;
    },
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
