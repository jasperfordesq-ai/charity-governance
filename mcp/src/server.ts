import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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
  createPostureResolver,
  fetchSessionPosture,
  permits,
  refusalFor,
  toolsFor,
} from './session-level.js';

import { ApiClient } from './client.js';
import type { Session } from './session.js';
import type { AccessLevel, ConnectorConfig } from './config.js';
import { OPERATOR_TOOLS, OPERATOR_TOOL_NAMES } from './operator-tools.js';
import { CONNECTOR_VERSION } from './version.js';
import { FETCH_TOOL, resolveReference } from './references.js';
import { RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources.js';
import { INSTRUCTIONS } from './instructions.js';
import { ConnectorError } from './errors.js';
import { errorResult, okResult } from './results.js';
import { SESSION_INFO_TOOL, runSessionInfo } from './session-info.js';
import { createDiagnostics } from './diagnostics.js';
import { findPrompt, promptListing } from './prompts.js';

const FILE_RANK: Record<AccessLevel, number> = { read: 0, write: 1, admin: 2 };

/**
 * Whether the operator has switched this file tool on.
 *
 * A tool that reads from or writes to this machine exists only when a
 * directory was named for it. One that does neither — text handed over in the
 * call itself — is always available.
 */
function fileToolEnabled(
  tool: FileToolDefinition,
  config: Partial<Pick<ConnectorConfig, 'uploadRoot' | 'downloadDir'>>,
): boolean {
  switch (tool.requires) {
    case 'uploadRoot':
      return Boolean(config.uploadRoot);
    case 'downloadDir':
      return Boolean(config.downloadDir);
    case 'nothing':
      return true;
  }
}

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
    return fileToolEnabled(tool, config);
  });
}

/** The file tools belong with the documents they move. */
const FILE_TOOL_GROUP: ToolGroup = 'documents';

/**
 * Search is offered whatever groups were asked for.
 *
 * It looks across every kind of record, so filing it under one group would
 * be arbitrary; and it is the tool that makes a narrow toolset workable,
 * because it is how an agent finds the identifier the narrowed tools take.
 * It still takes a `types` argument, so a narrowed session can narrow it too.
 */
const ALWAYS_OFFERED: ToolGroup = 'search';

function inToolsets(
  group: ToolGroup,
  toolsets: readonly ToolGroup[] | undefined,
): boolean {
  if (group === ALWAYS_OFFERED) return true;
  return toolsets === undefined || toolsets.includes(group);
}

export function buildToolList(
  level: AccessLevel = 'admin',
  config: Partial<
    Pick<ConnectorConfig, 'uploadRoot' | 'downloadDir' | 'allowPersonalData' | 'toolsets' | 'realm'>
  > = {},
) {
  // The operator realm REPLACES the charity surface rather than adding to it.
  // No search and no fetch: both resolve references into one charity's
  // records, which this realm does not reach. No file tools: there are no
  // documents here to move.
  if (config.realm === 'operator') {
    return [
      { ...SESSION_INFO_TOOL },
      ...toolsFor(level, OPERATOR_TOOLS, false).map((tool) => {
        const outputSchema = outputSchemaFor(tool);
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool),
          annotations: annotationsFor(tool),
          ...(outputSchema ? { outputSchema } : {}),
        };
      }),
    ];
  }

  return [
    // Always first and always offered: an agent has to be able to ask who it
    // is acting as before it does anything else, whatever the level or groups.
    { ...SESSION_INFO_TOOL },
    // Offered beside it for the same reason search is: a reference is
    // useless without the tool that reads it, and search is always offered.
    { ...FETCH_TOOL },
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
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: INSTRUCTIONS,
    },
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
  const posture = createPostureResolver(() => fetchSessionPosture(client), {
    accessLevel: config.accessLevel,
    allowPersonalData: config.allowPersonalData,
  });
  const level = async (): Promise<AccessLevel> => (await posture()).accessLevel;

  /**
   * Runs one tool and returns its raw value, or throws.
   *
   * Every refusal the connector makes itself is a ConnectorError with a code,
   * so the caller can turn any throw into a structured error result without
   * knowing which branch refused.
   */
  async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    // The operator realm is decided before anything else, because the two
    // branches below — fetch and the file tools — resolve references and move
    // documents inside ONE charity. Reaching them from an operator session
    // would be the one thing this realm exists to make impossible, and neither
    // is in the operator tool list, so both fall through to the refusal.
    //
    // session_info is the exception: an agent must be able to ask who it is
    // acting as before it does anything, in either realm.
    if (config.realm === 'operator' && name !== SESSION_INFO_TOOL.name) {
      return dispatchOperator(name, args);
    }

    if (name === FETCH_TOOL.name) {
      // Resolved to an ordinary tool call and run through this same
      // function, so the level, the toolsets and the personal-data gate are
      // applied in the one place they are applied for everything else. A
      // second copy of those checks here is a second copy to keep in step.
      const target = resolveReference(args.ref);
      return dispatch(target.tool, target.args);
    }

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
      if (!fileToolEnabled(fileTool, config)) {
        throw new ConnectorError('TOOL_DISABLED', unavailableBecause(fileTool));
      }
      return runFileTool(fileTool, client, config, args);
      // A file tool moves whole files, which the field policy cannot filter,
      // so the scope has nothing to say about it: a document is handed over
      // or it is not, and the directory setting is what decides.
    }

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      throw new ConnectorError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
    assertInToolsets(name, groupOf(tool), config.toolsets);

    // Re-checked here and not only in the listing: the Model Context Protocol
    // does not stop a client calling a tool it was never shown, and a tool
    // hidden from a list is not a tool that cannot be called.
    const held = await posture();
    if (!permits(held.accessLevel, tool)) {
      throw new ConnectorError('SESSION_LEVEL_TOO_LOW', refusalFor(held.accessLevel, tool), {
        action: 'reconnect',
      });
    }

    return runTool(tool, client, held.allowPersonalData, args);
  }

  /** Every tool call in the operator realm, and every refusal of one. */
  async function dispatchOperator(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const operatorTool = OPERATOR_TOOLS.find((t) => t.name === name);
    if (!operatorTool) {
      // A charity tool asked for by name in the operator realm gets its own
      // refusal, because the honest answer is not "no such tool". The tool
      // exists; this credential is the wrong one to reach it with, and an
      // agent told the name is unknown will try a different spelling rather
      // than a different realm.
      const isCharityTool = TOOLS.some((t) => t.name === name)
        || FILE_TOOLS.some((t) => t.name === name)
        || name === FETCH_TOOL.name;
      throw new ConnectorError(
        isCharityTool ? 'WRONG_REALM' : 'UNKNOWN_TOOL',
        isCharityTool
          ? `${name} reaches one charity's records, and this connector is signed in as a `
            + 'platform operator. An operator administers charities and never reads '
            + 'inside them. To read that charity, connect to it in the charity realm as '
            + `a person who belongs to it. The tools here are: ${OPERATOR_TOOL_NAMES.join(', ')}.`
          : `Unknown tool: ${name}. The operator realm offers: ${OPERATOR_TOOL_NAMES.join(', ')}.`,
        { action: 'reconnect' },
      );
    }

    // Re-checked here and not only in the listing, for the same reason the
    // charity realm re-checks: the Model Context Protocol does not stop a
    // client calling a tool it was never shown.
    const held = await posture();
    if (!permits(held.accessLevel, operatorTool)) {
      throw new ConnectorError(
        'SESSION_LEVEL_TOO_LOW',
        refusalFor(held.accessLevel, operatorTool),
        { action: 'reconnect' },
      );
    }

    // `false` rather than the held scope: the operator realm has no personal
    // data, so there is nothing for a gate to open.
    return runTool(operatorTool, client, false, args);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const held = await posture();
    return {
      tools: buildToolList(held.accessLevel, {
        ...config,
        // The API holds the scope, not the flag this process was started with.
        allowPersonalData: held.allowPersonalData,
      }),
    };
  });

  const diagnostics = createDiagnostics(config.verbose);

  // The multi-step governance jobs, offered to the person rather than
  // inferred by the model. They read nothing and change nothing by
  // themselves: each expands into a message naming the tools and the order.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: promptListing(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = findPrompt(request.params.name);
    if (!prompt) {
      throw new ConnectorError('UNKNOWN_PROMPT', `Unknown prompt: ${request.params.name}`);
    }

    return {
      description: prompt.description,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: prompt.build((request.params.arguments ?? {}) as Record<string, string>),
          },
        },
      ],
    };
  });

  // Reference data a client can attach without asking a question: the
  // Governance Code and the guidance behind it. Records are reachable the
  // same way, by the reference search hands out, but are not listed — there
  // may be thousands, and listing them would be a second, worse search.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map((resource) => ({ ...resource })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES.map((template) => ({ ...template })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // A record read as a resource goes through `dispatch`, so it meets the
    // level check, the toolset check and the personal-data gate exactly as
    // it would as a tool call. A resource that skipped them would be a way
    // around them.
    const contents = await readResource(request.params.uri, client, (tool, args) =>
      dispatch(tool, args));
    return { contents: [contents] };
  });

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
