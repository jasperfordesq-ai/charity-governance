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

interface Health {
  build?: { version?: string | null; revision?: string | null } | null;
}

/**
 * Whether `left` is a later release than `right`, by the three numbers.
 *
 * Not a semver library: the connector and the API are released from one
 * repository and only differ in those numbers, and the connector's two
 * runtime dependencies are a stated security property. Anything that is not
 * three numbers compares as equal, so an unreadable version produces no
 * warning rather than a wrong one.
 */
export function isNewerRelease(left: string | null, right: string | null): boolean {
  const parse = (value: string | null): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };

  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return false;

  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > b[index]!) return true;
    if (a[index]! < b[index]!) return false;
  }
  return false;
}

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
  const [me, posture, health] = await Promise.all([
    client.get<Me>('/api/v1/auth/me'),
    fetchSessionPosture(client),
    // A build older than this route, or one behind a proxy that hides it,
    // simply says nothing. Never a reason to fail the tool an agent is told
    // to call first.
    client.get<Health>('/api/v1/health').catch(() => null),
  ]);

  // What this answer may itself contain follows the session's scope, not the
  // flag: reporting the person's own name under a session that withholds it
  // would be the one place the policy did not apply.
  const allowPersonalData =
    posture?.dataScope === null || posture === null
      ? config.allowPersonalData
      : posture.dataScope === 'full';

  const apiVersion = health?.build?.version ?? null;

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
      // The scope is the session's, chosen by whoever typed the password. A
      // build older than the column reports null, and the flag stands in.
      dataScope: posture?.dataScope ?? (allowPersonalData ? 'full' : 'withheld'),
      clientKind: 'MCP_CONNECTOR',
    },
    connector: {
      version: CONNECTOR_VERSION,
      baseUrl: config.baseUrl,
      personalData: allowPersonalData ? 'released' : 'withheld',
    },
    api: {
      version: apiVersion,
      revision: health?.build?.revision ?? null,
      // Said plainly, because the symptom otherwise is a bare 404 from a
      // route the agent was told exists, and no way to tell that from a
      // route it asked for wrongly.
      ...(isNewerRelease(CONNECTOR_VERSION, apiVersion)
        ? {
          note:
            `This connector is ${CONNECTOR_VERSION} and CharityPilot is ${apiVersion}. `
            + 'Some tools may be refused as unknown routes until CharityPilot is updated. '
            + 'Tell the person; they deploy it.',
        }
        : {}),
    },
    account: allowPersonalData
      ? { name: me.name ?? null, email: me.email ?? null }
      : { note: 'Name and email are withheld while the personal-data gate is closed.' },
  };
}
