import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, runTool, toolInputSchema } from './tools.js';
import {
  fetchSessionPosture,
  permits,
  refusalFor,
  toolsFor,
} from './session-level.js';

import { ApiClient } from './client.js';
import type { Session } from './session.js';
import type { AccessLevel, ConnectorConfig } from './config.js';
import { CONNECTOR_VERSION } from './version.js';
import { redactSecrets } from './redact.js';

export function buildToolList(level: AccessLevel = 'admin') {
  return toolsFor(level, TOOLS).map((tool) => ({
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

  /**
   * The level the API says this session holds.
   *
   * Resolved once on the first request rather than at startup, because a
   * connector that could not reach the API at launch should still start and
   * report the problem per call, the way every other failure here does.
   */
  let held: AccessLevel | null = null;
  let resolving: Promise<AccessLevel> | null = null;

  async function level(): Promise<AccessLevel> {
    if (held) return held;
    if (!resolving) {
      resolving = fetchSessionPosture(client)
        .then((posture) => {
          // An API that cannot answer leaves the operator's own choice in
          // place. It is not a security decision: the server refuses what the
          // session may not do regardless of what is offered here.
          held = posture?.accessLevel ?? config.accessLevel;
          return held;
        })
        .finally(() => {
          resolving = null;
        });
    }
    return resolving;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(await level()),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    }

    // Re-checked here and not only in the listing: the Model Context Protocol
    // does not stop a client calling a tool it was never shown, and a tool
    // hidden from a list is not a tool that cannot be called.
    const current = await level();
    if (!permits(current, tool)) {
      return {
        isError: true,
        content: [{ type: 'text', text: refusalFor(current, tool) }],
      };
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
