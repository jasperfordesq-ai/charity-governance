import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * A connector session's own budget for changing things.
 *
 * The shared address bucket allows a hundred requests a minute. The connector
 * runs on the owner's machine, behind the owner's address, so an agent in a
 * retry loop would spend that budget and lock the owner out of their own web
 * session from the same laptop. Thirty writes a minute is far more than a
 * person directing an agent will ever need, and far less than a loop needs to
 * cause that.
 *
 * Counted per session rather than per address, so one agent cannot spend
 * another's budget, and a second connector session is unaffected by the first.
 *
 * Read traffic still shares the address bucket. That is a known limitation
 * rather than an oversight: reads cannot be distinguished from the web
 * application's own reads at the point the shared limiter runs, which is
 * before the session is known.
 */
export const CONNECTOR_WRITE_MAX_PER_MINUTE = 30;

const WINDOW_MS = 60_000;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Timestamps per session, trimmed on every read.
 *
 * In memory deliberately: the API runs as a single process, the existing
 * shared limiter is in memory too, and a budget that survived a restart would
 * be a new piece of persistent state to reason about for no gain. A restart
 * forgiving a loop its last few writes costs nothing.
 */
type Clock = () => number;

export function createWriteBudget(
  max = CONNECTOR_WRITE_MAX_PER_MINUTE,
  now: Clock = Date.now,
) {
  const hits = new Map<string, number[]>();

  return {
    /** Records an attempt and says whether it is within budget. */
    take(sessionId: string): { allowed: boolean; retryAfterSeconds: number } {
      const at = now();
      const cutoff = at - WINDOW_MS;
      const recent = (hits.get(sessionId) ?? []).filter((t) => t > cutoff);

      if (recent.length >= max) {
        hits.set(sessionId, recent);
        const oldest = recent[0] ?? at;
        return {
          allowed: false,
          // Rounded up, so a client obeying it never returns too early and
          // spends an attempt discovering it is still refused.
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + WINDOW_MS - at) / 1000),
          ),
        };
      }

      recent.push(at);
      hits.set(sessionId, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },

    /**
     * Drops sessions with nothing in the window. Called opportunistically
     * rather than on a timer: an unbounded map keyed by session id would grow
     * with every rotation, and sessions rotate every fifteen minutes.
     */
    sweep(): void {
      const cutoff = now() - WINDOW_MS;
      for (const [session, times] of hits) {
        if (times.every((t) => t <= cutoff)) hits.delete(session);
      }
    },

    get size(): number {
      return hits.size;
    },
  };
}

export type WriteBudget = ReturnType<typeof createWriteBudget>;

function isConnectorWrite(request: FastifyRequest): boolean {
  return (
    request.authSession?.clientKind === "MCP_CONNECTOR" &&
    !SAFE_METHODS.has(request.method)
  );
}

export const connectorWriteBudgetPlugin = fp(
  async (
    app: FastifyInstance,
    options: { budget?: WriteBudget; sweepEvery?: number } = {},
  ) => {
    const budget = options.budget ?? createWriteBudget();
    const sweepEvery = options.sweepEvery ?? 500;
    let since = 0;

    app.addHook("preHandler", async (request, reply) => {
      if (!isConnectorWrite(request)) return;

      if (++since >= sweepEvery) {
        since = 0;
        budget.sweep();
      }

      const verdict = budget.take(request.authSession.id);
      if (verdict.allowed) return;

      reply
        .header("retry-after", String(verdict.retryAfterSeconds))
        .status(429)
        .send({
          error:
            "This connector session has made too many changes in the last minute. "
            + "It is limited separately from the web application so an agent cannot "
            + "lock you out of your own session.",
          code: "CONNECTOR_WRITE_LIMIT",
        });
    });
  },
);
