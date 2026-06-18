import { createMcpAdapter, type NoemaLoomMcpServer } from './sdk.js';
import { createToolRegistry } from './tool-registry.js';

export function createNoemaLoomServer(): NoemaLoomMcpServer {
  const server = createMcpAdapter();

  for (const tool of createToolRegistry()) {
    server.registerTool(tool);
  }

  return server;
}

export async function serveMcp(): Promise<void> {
  await createNoemaLoomServer().connectStdio();
}
