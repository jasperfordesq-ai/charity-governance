import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Records what a non-browser client did.
 *
 * Written from one `onResponse` hook rather than from each route, for two
 * reasons. A route added later is covered without anyone remembering, which is
 * the failure mode the existing audit trail already has: roughly forty of the
 * mutating routes write no row. And the status code is known here, so a refused
 * attempt is recorded as readily as a successful change — an agent that tried
 * to delete something and was stopped is exactly the row worth reading.
 *
 * Only unsafe methods from connector sessions are recorded. A web session is
 * already a human at a keyboard, and reads would bury the writes in noise
 * without telling anyone anything they could act on.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Long enough for a sentence of justification, short enough not to be a store. */
const MAX_REASON_LENGTH = 500;

export const ACTIVITY_REASON_HEADER = "x-charitypilot-reason";

/**
 * Says the reason header is percent-encoded UTF-8.
 *
 * An HTTP header value is bytes, and fetch refuses any character above
 * U+00FF, so a reason with an em dash, an emoji, or text beyond Latin-1 cannot
 * be sent as it is written. The connector encodes such a reason and names the
 * encoding here; plain ASCII is still sent unencoded with no marker, so an
 * older connector and an older API both keep working.
 */
export const ACTIVITY_REASON_ENCODING_HEADER = "x-charitypilot-reason-encoding";
export const ACTIVITY_REASON_PERCENT_ENCODING = "percent";

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The reason the client gave, if any.
 *
 * Control characters are stripped: this is read back by humans, and a record
 * that can move the cursor around a terminal is a record that can lie about
 * what it says.
 */
export function reasonFrom(request: FastifyRequest): string | null {
  const raw = headerValue(request.headers[ACTIVITY_REASON_HEADER]);
  if (!raw) return null;
  const encoding = headerValue(request.headers[ACTIVITY_REASON_ENCODING_HEADER]);
  let text = raw;
  if (encoding?.trim().toLowerCase() === ACTIVITY_REASON_PERCENT_ENCODING) {
    try {
      text = decodeURIComponent(raw);
    } catch {
      // Malformed encoding: keep what arrived rather than lose the row's
      // reason. It is still text, and it is still cleaned below.
      text = raw;
    }
  }
  // Decoding happens before cleaning, so an encoded control character is
  // stripped exactly like a literal one.
  const cleaned = text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  // Counted in code points, so a cut never splits an emoji into a lone
  // surrogate that the database would store as a replacement character.
  return cleaned.length > 0 ? Array.from(cleaned).slice(0, MAX_REASON_LENGTH).join("") : null;
}

/**
 * The matched route pattern, never the requested path.
 *
 * `/board-members/:id` rather than `/board-members/clx123`: the identifier goes
 * in its own column, so this one stays groupable and does not become a second,
 * unindexed copy of the data it describes.
 */
function routePatternFor(request: FastifyRequest): string {
  const declared = request.routeOptions?.url;
  if (typeof declared === "string" && declared.length > 0) return declared;
  // No matched route means a 404. The path is recorded so an agent probing for
  // routes that do not exist is still visible, with the query string dropped.
  return `(unmatched) ${request.url.split("?")[0] ?? request.url}`;
}

function resourceIdFrom(request: FastifyRequest): string | null {
  const params = request.params as Record<string, unknown> | undefined;
  const id = params?.["id"];
  return typeof id === "string" && id.length > 0 ? id.slice(0, 200) : null;
}

// Wrapped with fastify-plugin deliberately. Registered without it, the hook
// would live in its own encapsulated scope and fire for nothing at all, which
// is a silence indistinguishable from a client that never wrote anything.
export const clientActivityLogPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onResponse", async (request, reply) => {
    const session = request.authSession;
    if (!session || session.clientKind !== "MCP_CONNECTOR") return;
    if (SAFE_METHODS.has(request.method)) return;

    const user = request.user;
    if (!user?.userId || !user?.organisationId) return;

    try {
      await request.server.prisma.clientActivityEvent.create({
        data: {
          organisationId: user.organisationId,
          userId: user.userId,
          sessionId: session.id,
          clientKind: session.clientKind,
          accessLevel: session.accessLevel,
          method: request.method,
          routePattern: routePatternFor(request),
          resourceId: resourceIdFrom(request),
          statusCode: reply.statusCode,
          requestId: request.id,
          reason: reasonFrom(request),
        },
      });
    } catch (error) {
      // The response has already been sent; there is nothing left to fail.
      // Losing the row is bad, and it is logged loudly, but turning a
      // successful write into an error the client never sees would be worse,
      // and it would leave the database and the client disagreeing about what
      // happened.
      request.log.error(
        { err: error, routePattern: routePatternFor(request) },
        "Failed to record client activity",
      );
    }
  });
});
