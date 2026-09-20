import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, runTool, toolInputSchema } from './tools.js';
import {
  FILE_TOOLS,
  runFileTool,
  unavailableBecause,
  type FileToolDefinition,
} from './file-tools.js';
import {
  createLevelResolver,
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
import { INSTRUCTIONS } from './instructions.js';

const FILE_RANK: Record<AccessLevel, number> = { read: 0, write: 1, admin: 2 };

/**
 * The file tools are advertised only when the operator enabled them.
 *
 * Offering a tool that is switched off would have a model try it and read the
 * refusal as a fault, rather than as a deliberate setting.
 */
function availableFileTools(
  level: AccessLevel,
  config: Partial<Pick<ConnectorConfig, 'uploadRoot' | 'downloadDir'>>,
): readonly FileToolDefinition[] {
  return FILE_TOOLS.filter((tool) => {
    if (FILE_RANK[level] < FILE_RANK[tool.level]) return false;
    return tool.requires === 'uploadRoot' ? Boolean(config.uploadRoot) : Boolean(config.downloadDir);
  });
}

export function buildToolList(
  level: AccessLevel = 'admin',
  config: Partial<Pick<ConnectorConfig, 'uploadRoot' | 'downloadDir' | 'allowPersonalData'>> = {},
) {
  return [
    ...toolsFor(level, TOOLS, config.allowPersonalData ?? false).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchema(tool),
    })),
    ...availableFileTools(level, config).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ];
}

export async function startServer(config: ConnectorConfig, session: Session): Promise<void> {
  const client = new ApiClient({ session, baseUrl: config.baseUrl });
  const server = new Server(
    { name: 'charitypilot', version: CONNECTOR_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  /**
   * The level the API says this session holds.
   *
   * Resolved on the first request rather than at startup, because a connector
   * that could not reach the API at launch should still start and report the
   * problem per call, the way every other failure here does. An API that
   * cannot answer leaves the operator's own choice in place for that call. It
   * is not a security decision: the server refuses what the session may not do
   * regardless of what is offered here.
   */
  const level = createLevelResolver(() => fetchSessionPosture(client), config.accessLevel);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(await level(), config),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fileTool = FILE_TOOLS.find((t) => t.name === request.params.name);
    if (fileTool) {
      const current = await level();
      if (FILE_RANK[current] < FILE_RANK[fileTool.level]) {
        return {
          isError: true,
          content: [{ type: 'text', text: refusalFor(current, { ...fileTool, path: '' }) }],
        };
      }
      const enabled =
        fileTool.requires === 'uploadRoot' ? config.uploadRoot : config.downloadDir;
      if (!enabled) {
        return { isError: true, content: [{ type: 'text', text: unavailableBecause(fileTool) }] };
      }
      try {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const result = await runFileTool(fileTool, client, config, args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: redactSecrets((error as Error).message) }],
        };
      }
    }

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
