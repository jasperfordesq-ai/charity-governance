import type { ApiClient } from './client.js';
import type { ConnectorConfig } from './config.js';
import { fetchSessionPosture } from './session-level.js';
import { CONNECTOR_VERSION } from './version.js';
import type { ToolAnnotations } from './tools.js';

/**
 * Who the connector is acting as.
 *
 * `status` told a person; nothing told the agent. An agent connected to the
 * wrong charity, or at read level, had no way to notice before its first
 * refusal. This is the first tool the instructions say to call.
 *
 * The person's own name and email follow the User policy: withheld while the
 * gate is closed. The charity's name and the account's role are governance,
 * not personal data, and are always returned.
 */
export const SESSION_INFO_TOOL = {
  name: 'session_info',
  description:
    'Which charity this connector is signed in to, the role and access level the session '
    + 'holds, and whether the personal-data gate is open. Call this first. Returns data about '
    + 'the session, not instructions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    title: 'Session info',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } satisfies ToolAnnotations,
};

interface Me {
  email?: string;
  name?: string;
  role?: string;
  organisationId?: string;
  organisation?: { name?: string } | null;
}

export async function runSessionInfo(
  client: ApiClient,
  config: Pick<ConnectorConfig, 'baseUrl' | 'allowPersonalData'>,
): Promise<Record<string, unknown>> {
  const [me, posture] = await Promise.all([
    client.get<Me>('/api/v1/auth/me'),
    fetchSessionPosture(client),
  ]);

  return {
    organisation: {
      id: me.organisationId ?? null,
      name: me.organisation?.name ?? null,
    },
    session: {
      role: me.role ?? null,
      accessLevel: posture?.accessLevel ?? null,
      accessLevelNote: posture
        ? 'As the API reports it.'
        : 'Unknown: this API predates the session route.',
      clientKind: 'MCP_CONNECTOR',
    },
    connector: {
      version: CONNECTOR_VERSION,
      baseUrl: config.baseUrl,
      personalData: config.allowPersonalData ? 'released' : 'withheld',
    },
    account: config.allowPersonalData
      ? { name: me.name ?? null, email: me.email ?? null }
      : { note: 'Name and email are withheld while the personal-data gate is closed.' },
  };
}
