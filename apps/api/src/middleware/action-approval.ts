import type { FastifyRequest, FastifyReply } from "fastify";
import { digestAction } from "../utils/action-digest.js";

/**
 * Requires a human approval, typed at a terminal, for one destructive action.
 *
 * Applied beside requireSessionLevel('ADMIN'). The level says the session was
 * connected with the authority to destroy things; this says a person agreed to
 * this particular destruction, just now.
 *
 * Only connector sessions meet it. A web session is a human already looking at
 * the screen they are about to change, and interposing a password prompt there
 * would train people to type their password at prompts.
 */
export const APPROVAL_HEADER = "x-charitypilot-approval";

/** Long enough to read a summary and type a password, short enough to be useless later. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/**
 * What the person is being asked to agree to, in words.
 *
 * Built from the route the API matched, never from anything the client sent: a
 * summary the caller writes is a summary the caller can lie in, and the whole
 * value of the prompt is that it describes what will actually happen.
 */
export function summarise(method: string, routePattern: string): string {
  const verb =
    method === "DELETE"
      ? "Permanently delete"
      : method === "PATCH" || method === "PUT"
        ? "Change"
        : "Carry out";

  const subject = routePattern
    .replace(/^\/api\/v1/, "")
    .replace(/\/:[A-Za-z]+/g, "")
    .replace(/^\//, "")
    .replace(/[-/]/g, " ")
    .trim();

  return `${verb}: ${subject || routePattern} (${method})`;
}

interface ApprovalRow {
  id: string;
  approvedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  sessionFamilyId: string;
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requireActionApproval() {
  return async function actionApprovalGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const session = request.authSession;
    if (!session || session.clientKind !== "MCP_CONNECTOR") return;

    const routePattern = request.routeOptions?.url ?? request.url;
    // Keyed on the family, not the session row. Rotation mints a new row on
    // every refresh, so an approval bound to the row id would be dead before
    // anyone could type a password — which is the one thing it exists to wait
    // for. The family is stable for the life of a sign-in, and a separately
    // signed-in connector still has a different one.
    const digest = digestAction({
      sessionId: session.familyId,
      method: request.method,
      path: request.url,
      body: request.body,
    });

    const offered = headerValue(request.headers[APPROVAL_HEADER]);
    const now = new Date();

    if (offered) {
      const approval = (await request.server.prisma.authActionApproval.findFirst(
        {
          where: {
            id: offered,
            organisationId: request.user.organisationId,
          },
          select: {
            id: true,
            approvedAt: true,
            consumedAt: true,
            expiresAt: true,
            sessionFamilyId: true,
          },
        },
      )) as ApprovalRow | null;

      // Every failure below is reported identically. Telling a caller which of
      // "no such approval", "not yours", "not approved yet", "already used" and
      // "expired" applies would let an agent map the approval space by trying.
      const usable =
        approval !== null &&
        approval.sessionFamilyId === session.familyId &&
        approval.approvedAt !== null &&
        approval.consumedAt === null &&
        approval.expiresAt > now;

      if (usable) {
        // Consumed by digest as well as by id, inside one conditional update,
        // so two requests racing for the same approval cannot both spend it.
        const spent = await request.server.prisma.authActionApproval.updateMany(
          {
            where: {
              id: approval.id,
              sessionFamilyId: session.familyId,
              requestDigest: digest,
              consumedAt: null,
              approvedAt: { not: null },
              expiresAt: { gt: now },
            },
            data: { consumedAt: now },
          },
        );

        if (spent.count === 1) return;
      }
    }

    // No usable approval: mint one for exactly this request and tell the
    // caller what to run. The row is created unapproved; only the password
    // route can approve it.
    const summary = summarise(request.method, routePattern);
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);

    // One live approval per session and digest, so asking twice does not leave
    // two approvals lying around for one distracted person to grant. The
    // database enforces that with a partial unique index, which Prisma cannot
    // address in an upsert, so the read-then-create is written out and the
    // losing side of a race falls back to the row the winner made.
    const live = async () =>
      request.server.prisma.authActionApproval.findFirst({
        where: {
          sessionFamilyId: session.familyId,
          requestDigest: digest,
          consumedAt: null,
        },
        select: { id: true, summary: true, expiresAt: true, approvedAt: true },
      });

    let pending = await live();

    if (pending) {
      // An unapproved request may be asked again, and its clock restarts. An
      // approved one is left alone: extending it would turn a five-minute
      // approval into one an agent could keep alive indefinitely by asking.
      if (pending.approvedAt === null) {
        await request.server.prisma.authActionApproval.updateMany({
          where: { id: pending.id, consumedAt: null, approvedAt: null },
          data: { expiresAt, summary },
        });
        pending = { ...pending, expiresAt, summary };
      }
    } else {
      try {
        pending = await request.server.prisma.authActionApproval.create({
          data: {
            organisationId: request.user.organisationId,
            userId: request.user.userId,
            sessionFamilyId: session.familyId,
            requestDigest: digest,
            summary,
            method: request.method,
            routePattern,
            expiresAt,
          },
          select: { id: true, summary: true, expiresAt: true, approvedAt: true },
        });
      } catch {
        pending = await live();
      }
    }

    if (!pending) {
      // The only way here is a row created and consumed between the two reads.
      // Refusing is correct: there is nothing left for this request to spend.
      reply.status(409).send({
        error: "That approval was used while this request was being prepared. Try again.",
        code: "APPROVAL_RACED",
      });
      return;
    }

    reply.status(428).send({
      error:
        "This action needs your approval. Run the command below in your own "
        + "terminal; the password is typed there, not here.",
      code: "APPROVAL_REQUIRED",
      approvalId: pending.id,
      summary: pending.summary,
      expiresAt: pending.expiresAt.toISOString(),
      command: `charitypilot-mcp approve ${pending.id}`,
    });
  };
}
