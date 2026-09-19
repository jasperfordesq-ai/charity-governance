import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, runTool, toolInputSchema } from './tools.js';

import { ApiClient } from './client.js';
import type { Session } from './session.js';
import type { ConnectorConfig } from './config.js';
import { CONNECTOR_VERSION } from './version.js';
import { redactSecrets } from './redact.js';

export function buildToolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool),
  }));
}

export async function startServer(config: ConnectorConfig, session: Session): Promise<void> {
  const client = new ApiClient({ session, baseUrl: config.baseUrl });
  const server = new Server(
    { name: 'charitypilot', version: CONNECTOR_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await runTool(tool, client, config.allowPersonalData, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: redactSecrets((error as Error).message) }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
