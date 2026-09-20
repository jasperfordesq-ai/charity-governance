import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  TOOLS,
  annotationsFor,
  outputSchemaFor,
  runTool,
  toolInputSchema,
} from './tools.js';
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
import { INSTRUCTIONS } from './instructions.js';
import { ConnectorError } from './errors.js';
import { errorResult, okResult } from './results.js';
import { SESSION_INFO_TOOL, runSessionInfo } from './session-info.js';

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
    // Always first and always offered: an agent has to be able to ask who it
    // is acting as before it does anything else, whatever the level.
    { ...SESSION_INFO_TOOL },
    ...toolsFor(level, TOOLS, config.allowPersonalData ?? false).map((tool) => {
      const outputSchema = outputSchemaFor(tool);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: toolInputSchema(tool),
        annotations: annotationsFor(tool),
        ...(outputSchema ? { outputSchema } : {}),
      };
    }),
    ...availableFileTools(level, config).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
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

  /**
   * Runs one tool and returns its raw value, or throws.
   *
   * Every refusal the connector makes itself is a ConnectorError with a code,
   * so the caller can turn any throw into a structured error result without
   * knowing which branch refused.
   */
  async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === SESSION_INFO_TOOL.name) {
      return runSessionInfo(client, config);
    }

    const fileTool = FILE_TOOLS.find((t) => t.name === name);
    if (fileTool) {
      const current = await level();
      if (FILE_RANK[current] < FILE_RANK[fileTool.level]) {
        throw new ConnectorError(
          'SESSION_LEVEL_TOO_LOW',
          refusalFor(current, { ...fileTool, path: '' }),
          { action: 'reconnect' },
        );
      }
      const enabled =
        fileTool.requires === 'uploadRoot' ? config.uploadRoot : config.downloadDir;
      if (!enabled) {
        throw new ConnectorError('TOOL_DISABLED', unavailableBecause(fileTool));
      }
      return runFileTool(fileTool, client, config, args);
    }

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      throw new ConnectorError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }

    // Re-checked here and not only in the listing: the Model Context Protocol
    // does not stop a client calling a tool it was never shown, and a tool
    // hidden from a list is not a tool that cannot be called.
    const current = await level();
    if (!permits(current, tool)) {
      throw new ConnectorError('SESSION_LEVEL_TOO_LOW', refusalFor(current, tool), {
        action: 'reconnect',
      });
    }

    return runTool(tool, client, config.allowPersonalData, args);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(await level(), config),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return okResult(await dispatch(request.params.name, args));
    } catch (error) {
      return errorResult(error);
    }
  });

  await server.connect(new StdioServerTransport());
}
