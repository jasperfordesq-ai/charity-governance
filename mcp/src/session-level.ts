import type { ApiClient } from './client.js';
import type { AccessLevel, DataScope } from './config.js';
import { needsPersonalData, type ToolDefinition } from './tools.js';

/**
 * What the session is actually allowed to do, as the API sees it.
 *
 * Read from the server rather than taken from the flag the connector was
 * started with. The two can disagree: `serve --access-level admin` against a
 * credential minted at read level would otherwise advertise every write tool
 * and then fail on each one, which reads to a model as a broken tool rather
 * than as a session that was never allowed to write.
 *
 * This is convenience, not security. The API refuses what the level does not
 * permit whatever the connector chooses to offer, and an MCP client can call a
 * tool it was never shown — which is why the check is repeated at call time.
 */
const RANK: Record<AccessLevel, number> = { read: 0, write: 1, admin: 2 };

export interface SessionPosture {
  accessLevel: AccessLevel;
  /**
   * How much personal data this session may see, as the API holds it. A build
   * older than the column says nothing, and the caller falls back to what the
   * operator asked for.
   */
  dataScope: DataScope | null;
  role: string;
}

interface SessionResponse {
  accessLevel?: string;
  dataScope?: string;
  role?: string;
}

export async function fetchSessionPosture(
  client: ApiClient,
): Promise<SessionPosture | null> {
  try {
    const body = await client.get<SessionResponse>('/api/v1/auth/connector/session');
    const level = String(body.accessLevel ?? '').toLowerCase();
    if (level !== 'read' && level !== 'write' && level !== 'admin') return null;
    const scope = String(body.dataScope ?? '').toLowerCase();
    return {
      accessLevel: level,
      dataScope: scope === 'full' ? 'full' : scope === 'withheld' ? 'withheld' : null,
      role: String(body.role ?? 'unknown'),
    };
  } catch {
    // An API that predates this route, or one that cannot be reached right
    // now. Returning null means "unknown", and the caller falls back to the
    // level the operator asked for rather than refusing to start.
    return null;
  }
}

/**
 * Resolves the level once and keeps it, but keeps only an answer.
 *
 * A connector that could not reach the API on its first request used to cache
 * the operator's flag for the life of the process, so a transient outage at
 * launch advertised the wrong tool list until the client restarted it. An
 * unknown posture now stands in for one call and is asked for again on the
 * next.
 */
export interface HeldPosture {
  accessLevel: AccessLevel;
  /** True when the API says this session may see personal data. */
  allowPersonalData: boolean;
}

export function createPostureResolver(
  fetchPosture: () => Promise<SessionPosture | null>,
  fallback: HeldPosture,
): () => Promise<HeldPosture> {
  let held: HeldPosture | null = null;
  let resolving: Promise<HeldPosture> | null = null;

  return async () => {
    if (held) return held;
    if (!resolving) {
      resolving = fetchPosture()
        .then((posture) => {
          if (!posture) return fallback;
          held = {
            accessLevel: posture.accessLevel,
            // A build older than the data-scope column says nothing about it.
            // The operator's own choice stands in, exactly as it did before
            // the column existed, rather than silently widening or narrowing.
            allowPersonalData:
              posture.dataScope === null
                ? fallback.allowPersonalData
                : posture.dataScope === 'full',
          };
          return held;
        })
        .finally(() => {
          resolving = null;
        });
    }
    return resolving;
  };
}

export function permits(held: AccessLevel, tool: ToolDefinition): boolean {
  return RANK[held] >= RANK[tool.level ?? 'read'];
}

export function toolsFor(
  held: AccessLevel,
  tools: readonly ToolDefinition[],
  allowPersonalData = false,
): readonly ToolDefinition[] {
  return tools.filter((tool) => {
    if (!permits(held, tool)) return false;
    // A write whose fields the gate withholds is not offered while the gate is
    // closed. Offering it would mean advertising a tool that refuses every
    // valid call, which reads as a fault rather than as a setting.
    return allowPersonalData || !needsPersonalData(tool);
  });
}

/**
 * The message a caller gets for a tool its session may not use.
 *
 * Says what would have to change and who can change it, because the agent
 * cannot: re-connecting means a password, typed by a person.
 */
export function refusalFor(held: AccessLevel, tool: ToolDefinition): string {
  return (
    `${tool.name} needs a session with ${tool.level ?? 'read'} access, and this one has `
    + `${held} access. Nothing was sent. To change that, run `
    + `"charitypilot-mcp connect --access-level ${tool.level ?? 'read'}" yourself and sign in again.`
  );
}
