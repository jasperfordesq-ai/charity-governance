import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  TOOLS,
  annotationsFor,
  groupOf,
  outputSchemaFor,
  runTool,
  toolInputSchema,
  type ToolGroup,
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
import { createDiagnostics } from './diagnostics.js';

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

/** The file tools belong with the documents they move. */
const FILE_TOOL_GROUP: ToolGroup = 'documents';

function inToolsets(
  group: ToolGroup,
  toolsets: readonly ToolGroup[] | undefined,
): boolean {
  return toolsets === undefined || toolsets.includes(group);
}

export function buildToolList(
  level: AccessLevel = 'admin',
  config: Partial<
    Pick<ConnectorConfig, 'uploadRoot' | 'downloadDir' | 'allowPersonalData' | 'toolsets'>
  > = {},
) {
  return [
    // Always first and always offered: an agent has to be able to ask who it
    // is acting as before it does anything else, whatever the level or groups.
    { ...SESSION_INFO_TOOL },
    ...toolsFor(level, TOOLS, config.allowPersonalData ?? false)
      .filter((tool) => inToolsets(groupOf(tool), config.toolsets))
      .map((tool) => {
      const outputSchema = outputSchemaFor(tool);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: toolInputSchema(tool),
        annotations: annotationsFor(tool),
        ...(outputSchema ? { outputSchema } : {}),
      };
    }),
    ...(inToolsets(FILE_TOOL_GROUP, config.toolsets)
      ? availableFileTools(level, config).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }))
      : []),
  ];
}

/**
 * A tool outside the enabled groups is refused if called, because a client
 * may call a tool it was never shown. This is a setting, not a security
 * control: the API refuses what the session may not do regardless.
 */
function assertInToolsets(name: string, group: ToolGroup, toolsets: readonly ToolGroup[] | undefined): void {
  if (inToolsets(group, toolsets)) return;
  throw new ConnectorError(
    'TOOL_DISABLED',
    `${name} is in the "${group}" tool group, and this connector was started with `
      + `--toolsets ${(toolsets ?? []).join(',')}. Nothing was sent. The person running the `
      + 'connector can widen the list.',
  );
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
      assertInToolsets(name, FILE_TOOL_GROUP, config.toolsets);
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
    assertInToolsets(name, groupOf(tool), config.toolsets);

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

  const diagnostics = createDiagnostics(config.verbose);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    try {
      const value = await dispatch(request.params.name, args);
      diagnostics.toolCall(request.params.name, 'ok', Date.now() - started);
      return okResult(value);
    } catch (error) {
      const result = errorResult(error);
      diagnostics.toolCall(
        request.params.name,
        `error ${String(result.structuredContent['code'])}`,
        Date.now() - started,
      );
      return result;
    }
  });

  await server.connect(new StdioServerTransport());
}
