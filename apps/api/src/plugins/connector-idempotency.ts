import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { digestAction } from "../utils/action-digest.js";

/**
 * Answers a retried connector create with the first attempt's answer, instead
 * of creating a second record.
 *
 * The case this exists for is a dropped connection. The API created the
 * governing act, the response never arrived, and the agent cannot tell that
 * from a request that never ran. Retrying is the only reasonable thing it can
 * do, and without this, retrying makes two acts where a board held one
 * meeting.
 *
 * POST only. An update already carries `expectedUpdatedAt` and a removal
 * already needs a human approval, so both are safe to repeat; a create is the
 * one that duplicates. Connector sessions only, for the same reason the
 * activity record is connector-only: a person at a keyboard sees the response.
 *
 * Opt-in. A request with no `Idempotency-Key` behaves exactly as it did
 * before, so nothing that works today starts failing because this shipped.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Long enough to cover a retry the next morning, short enough to forget. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claimed-but-unanswered row is believed.
 *
 * A process that died between claiming and answering leaves a row that says
 * "in flight" forever, and every retry would be refused for a day. Past this
 * window the row is treated as abandoned and taken over, so the retry runs.
 * Longer than any request this API serves, so it cannot fire on a slow one.
 */
export const IDEMPOTENCY_IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;

/**
 * Responses larger than this are not kept.
 *
 * No route reached by a connector create comes near it — the largest is one
 * governing act with its resolutions. The cap exists so that a route added
 * later cannot quietly turn this table into a response cache.
 */
export const IDEMPOTENCY_MAX_BODY_BYTES = 256 * 1024;

/**
 * Printable ASCII, no spaces, no control characters, bounded.
 *
 * Bounded because it is stored and echoed; printable because a key that can
 * move a terminal cursor is a key that can lie about what it is.
 */
const KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;

declare module "fastify" {
  interface FastifyRequest {
    /** The row this request claimed, which its response must complete. */
    idempotencyClaimId?: string;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "P2002",
  );
}

interface ClaimRow {
  id: string;
  requestDigest: string;
  createdAt: Date;
  completedAt: Date | null;
  statusCode: number | null;
  responseBody: string | null;
}

function replay(reply: FastifyReply, row: ClaimRow): FastifyReply {
  reply.header("idempotent-replay", "true");

  if (row.responseBody === null) {
    // Only reachable for a response that was too large to keep, or one that
    // had no body at all. Saying so is the honest answer: the original
    // request did take effect, and inventing a body would be a different
    // answer wearing the first one's status code.
    return reply.status(row.statusCode ?? 200).send({
      code: "IDEMPOTENT_REPLAY_WITHOUT_BODY",
      error:
        "This request was already carried out with the same Idempotency-Key. "
        + "Its response was not kept, so it cannot be repeated here. Read the record "
        + "back rather than sending this again.",
    });
  }

  return reply
    .status(row.statusCode ?? 200)
    .type("application/json; charset=utf-8")
    .send(row.responseBody);
}

export const connectorIdempotencyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.authSession;
    if (!session || session.clientKind !== "MCP_CONNECTOR") return;
    if (request.method !== "POST") return;

    const key = headerValue(request.headers[IDEMPOTENCY_HEADER]);
    if (key === undefined) return;

    if (!KEY_PATTERN.test(key)) {
      return reply.status(400).send({
        error:
          "Idempotency-Key must be 8 to 255 printable characters with no spaces. "
          + "A value that is short or predictable is not a key: use a fresh random "
          + "one for each distinct request.",
        code: "IDEMPOTENCY_KEY_INVALID",
      });
    }

    const user = request.user;
    if (!user?.userId || !user?.organisationId) return;

    const routePattern = request.routeOptions?.url ?? request.url;
    // The principal here is the user rather than the session, because a
    // session rotates every fifteen minutes and a retry that crossed a
    // rotation must still be recognised as the same request.
    const requestDigest = digestAction({
      sessionId: user.userId,
      method: request.method,
      path: request.url,
      body: request.body,
    });

    const prisma = request.server.prisma;
    const now = new Date();

    // Swept here rather than on a timer: the table only grows when somebody
    // uses a key, so the moment somebody uses one is the right moment to
    // forget the old ones. Scoped to this user, so it stays a small delete.
    await prisma.connectorIdempotencyRecord.deleteMany({
      where: { userId: user.userId, expiresAt: { lt: now } },
    });

    const claim = async (): Promise<string | undefined> => {
      try {
        const row = await prisma.connectorIdempotencyRecord.create({
          data: {
            organisationId: user.organisationId,
            userId: user.userId,
            key,
            requestDigest,
            method: request.method,
            routePattern,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
          select: { id: true },
        });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error)) return undefined;
        throw error;
      }
    };

    const claimed = await claim();
    if (claimed !== undefined) {
      request.idempotencyClaimId = claimed;
      return;
    }

    const existing = (await prisma.connectorIdempotencyRecord.findUnique({
      where: { userId_key: { userId: user.userId, key } },
      select: {
        id: true,
        requestDigest: true,
        createdAt: true,
        completedAt: true,
        statusCode: true,
        responseBody: true,
      },
    })) as ClaimRow | null;

    // Raced with the sweep above, or with another request's abandonment
    // takeover. Nothing is being duplicated, so let it run unguarded rather
    // than refuse a request that has done nothing wrong.
    if (!existing) return;

    if (existing.requestDigest !== requestDigest) {
      return reply.status(422).send({
        error:
          "This Idempotency-Key was already used for a different request. A key "
          + "identifies one request, so reusing it for another would answer you with "
          + "the first one's result. Send this request with a new key.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }

    if (existing.completedAt === null) {
      const abandoned =
        now.getTime() - existing.createdAt.getTime() > IDEMPOTENCY_IN_FLIGHT_GRACE_MS;

      if (!abandoned) {
        return reply.header("retry-after", "2").status(409).send({
          error:
            "An identical request with this Idempotency-Key is still being carried "
            + "out. Wait for it rather than sending it again.",
          code: "IDEMPOTENCY_KEY_IN_FLIGHT",
        });
      }

      // The attempt that claimed this never answered — its process died, or it
      // was killed mid-flight. Delete on the same condition that was read, so
      // an attempt that is merely slow and lands in between keeps its claim and
      // this request refuses instead of running beside it.
      const removed = await prisma.connectorIdempotencyRecord.deleteMany({
        where: { id: existing.id, completedAt: null },
      });

      if (removed.count === 0) {
        return reply.header("retry-after", "2").status(409).send({
          error:
            "An identical request with this Idempotency-Key answered a moment ago. "
            + "Send it again to be given that answer.",
          code: "IDEMPOTENCY_KEY_IN_FLIGHT",
        });
      }

      const retaken = await claim();
      if (retaken !== undefined) {
        request.idempotencyClaimId = retaken;
        return;
      }
      // Somebody else took it over first; they are now in flight.
      return reply.header("retry-after", "2").status(409).send({
        error:
          "An identical request with this Idempotency-Key is still being carried "
          + "out. Wait for it rather than sending it again.",
        code: "IDEMPOTENCY_KEY_IN_FLIGHT",
      });
    }

    return replay(reply, existing);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const claimId = request.idempotencyClaimId;
    if (claimId === undefined) return payload;
    // Cleared first: a replayed response must never complete a second row, and
    // an onSend that ran twice must not write twice.
    request.idempotencyClaimId = undefined;

    const prisma = request.server.prisma;

    try {
      if (reply.statusCode >= 500) {
        // The claim is released rather than completed. A failure this shape may
        // mean the request never ran at all, and a retry must be allowed to run
        // it. The risk that it half-ran and the retry duplicates is the risk
        // that exists today with no key at all, so this is no worse — and the
        // alternative, remembering a 500 for a day, would be.
        await prisma.connectorIdempotencyRecord.deleteMany({ where: { id: claimId } });
        return payload;
      }

      const body = typeof payload === "string" ? payload : null;
      await prisma.connectorIdempotencyRecord.update({
        where: { id: claimId },
        data: {
          completedAt: new Date(),
          statusCode: reply.statusCode,
          responseBody:
            body !== null && Buffer.byteLength(body, "utf8") <= IDEMPOTENCY_MAX_BODY_BYTES
              ? body
              : null,
        },
      });
    } catch (error) {
      // The response is about to be sent either way. Failing it now would turn
      // a create that already happened into an error the client will retry,
      // which is the exact duplicate this plugin exists to prevent.
      request.log.error(
        { err: error, claimId },
        "Failed to record an idempotent response; a retry will run again",
      );
    }

    return payload;
  });
});
