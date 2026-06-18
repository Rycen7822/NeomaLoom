import {
  McpServer,
  StdioServerTransport,
  type StandardSchemaWithJSON
} from '@modelcontextprotocol/server';

export type SdkToolSpec = {
  name: string;
  description: string;
  inputSchema: StandardSchemaWithJSON;
  handler: (args: unknown) => Promise<unknown>;
};

export type NoemaLoomMcpServer = {
  registerTool: (tool: SdkToolSpec) => void;
  connectStdio: () => Promise<void>;
};

export function createMcpAdapter(): NoemaLoomMcpServer {
  const server = new McpServer({
    name: 'noemaloom',
    version: '0.0.0'
  });

  return {
    registerTool(tool) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema
        },
        async args => {
          const envelope = await tool.handler(args);

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(envelope)
              }
            ]
          };
        }
      );
    },
    async connectStdio() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  };
}
