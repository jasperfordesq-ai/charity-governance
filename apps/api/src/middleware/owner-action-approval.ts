import type { FastifyRequest, FastifyReply } from 'fastify';
import { digestAction } from '../utils/action-digest.js';

/**
 * Requires a human approval, typed at a terminal, for one operator action.
 *
 * The twin of `middleware/action-approval.ts`, and written to read the same,
 * because two security-critical paths that look alike stay alike. What differs
 * is the identity — an operator belongs to no organisation — and the summary,
 * which names the charity rather than a record inside one.
 *
 * Only connector sessions meet it. The console is a person already looking at
 * the screen they are about to change, and interposing a password prompt there
 * would train operators to type their password at prompts.
 *
 * Why every operator write and not only the destructive ones: a charity
 * connector's mistake is contained to one charity, whose own people can see it
 * in their activity record. An operator's reaches across tenants, and closing
 * a charity is the most destructive action in the product. There is no operator
 * write cheap enough to be worth leaving unconfirmed.
 */
export const OPERATOR_APPROVAL_HEADER = 'x-charitypilot-approval';

/** Long enough to read a summary and type a password, short enough to be useless later. */
export const OPERATOR_APPROVAL_TTL_MS = 5 * 60 * 1000;

interface OperatorApprovalRow {
  id: string;
  approvedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  sessionFamilyId: string;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * What the operator is being asked to agree to, in words.
 *
 * Built from the route the API matched and the tenant the API read, never from
 * anything the client sent: a summary the caller writes is a summary the caller
 * can lie in, and the whole value of the prompt is that it describes what will
 * actually happen.
 */
export function summariseOperatorAction(
  method: string,
  routePattern: string,
  tenantName: string | null,
  body: unknown,
): string {
  const lifecycle =
    routePattern.endsWith('/lifecycle') && body && typeof body === 'object'
      ? (body as { action?: unknown }).action
      : undefined;

  const subject = tenantName ? `"${tenantName}"` : 'a charity';

  if (typeof lifecycle === 'string') {
    const verb =
      lifecycle === 'CLOSE'
        ? 'CLOSE'
        : lifecycle === 'SUSPEND'
          ? 'Suspend'
          : lifecycle === 'REACTIVATE'
            ? 'Reactivate'
            : lifecycle;
    // Closing is named in capitals and said plainly. It is the most
    // destructive action in the product and the person approving it should
    // not have to decode a route pattern to notice.
    return lifecycle === 'CLOSE'
      ? `${verb} the charity ${subject} — this ends its access to CharityPilot`
      : `${verb} the charity ${subject}`;
  }

  if (routePattern.endsWith('/configuration')) {
    return `Change the platform configuration of ${subject}`;
  }

  if (method === 'POST' && routePattern.endsWith('/tenants')) {
    return 'Create a new charity on this platform';
  }

  return `Carry out ${method} ${routePattern} on ${subject}`;
}

/**
 * Reads the tenant's name for the summary, when the route names one.
 *
 * Only the name. This runs inside the operator realm, which exposes no
 * personal data, and a summary is not the place to start.
 */
async function tenantLabel(
  request: FastifyRequest,
  tenantId: string | undefined,
): Promise<{ resourceId: string | null; resourceLabel: string | null }> {
  if (!tenantId) return { resourceId: null, resourceLabel: null };
  const tenant = await request.server.prisma.organisation.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  return { resourceId: tenantId, resourceLabel: tenant?.name ?? null };
}

export function requireOperatorActionApproval() {
  return async function operatorActionApprovalGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> {
    const session = request.operatorSession;
    if (!session || session.clientKind !== 'MCP_CONNECTOR') return;

    const routePattern = request.routeOptions?.url ?? request.url;
    // Keyed on the family, not the session row. Rotation mints a new row on
    // every refresh, so an approval bound to the row id would be dead before
    // anyone could type a password — which is the one thing it exists to wait
    // for.
    const digest = digestAction({
      sessionId: session.familyId,
      method: request.method,
      path: request.url,
      body: request.body,
    });

    const offered = headerValue(request.headers[OPERATOR_APPROVAL_HEADER]);
    const now = new Date();

    if (offered) {
      const approval = (await request.server.prisma.operatorActionApproval.findFirst({
        where: { id: offered, operatorId: request.operator.id },
        select: {
          id: true,
          approvedAt: true,
          consumedAt: true,
          expiresAt: true,
          sessionFamilyId: true,
        },
      })) as OperatorApprovalRow | null;

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
        const spent = await request.server.prisma.operatorActionApproval.updateMany({
          where: {
            id: approval.id,
            sessionFamilyId: session.familyId,
            requestDigest: digest,
            consumedAt: null,
            approvedAt: { not: null },
            expiresAt: { gt: now },
          },
          data: { consumedAt: now },
        });

        if (spent.count === 1) return;
      }
    }

    // No usable approval: mint one for exactly this request and tell the caller
    // what to run. The row is created unapproved; only the password route can
    // approve it.
    const { resourceId, resourceLabel } = await tenantLabel(
      request,
      (request.params as { id?: string } | undefined)?.id,
    );
    const summary = summariseOperatorAction(request.method, routePattern, resourceLabel, request.body);
    const expiresAt = new Date(now.getTime() + OPERATOR_APPROVAL_TTL_MS);

    // One live approval per family and digest, so asking twice does not leave
    // two approvals lying around for one distracted person to grant. The
    // database enforces that with a partial unique index, which Prisma cannot
    // address in an upsert, so the read-then-create is written out and the
    // losing side of a race falls back to the row the winner made.
    const live = async () =>
      request.server.prisma.operatorActionApproval.findFirst({
        where: { sessionFamilyId: session.familyId, requestDigest: digest, consumedAt: null },
        select: {
          id: true,
          summary: true,
          resourceId: true,
          resourceLabel: true,
          expiresAt: true,
          approvedAt: true,
        },
      });

    let pending = await live();

    if (pending) {
      // An unapproved request may be asked again, and its clock restarts. An
      // approved one is left alone: extending it would turn a five-minute
      // approval into one an agent could keep alive indefinitely by asking.
      if (pending.approvedAt === null) {
        await request.server.prisma.operatorActionApproval.updateMany({
          where: { id: pending.id, consumedAt: null, approvedAt: null },
          data: { expiresAt, summary },
        });
        pending = { ...pending, expiresAt, summary };
      }
    } else {
      try {
        pending = await request.server.prisma.operatorActionApproval.create({
          data: {
            operatorId: request.operator.id,
            sessionFamilyId: session.familyId,
            requestDigest: digest,
            summary,
            method: request.method,
            routePattern,
            resourceId,
            resourceLabel,
            expiresAt,
          },
          select: {
            id: true,
            summary: true,
            resourceId: true,
            resourceLabel: true,
            expiresAt: true,
            approvedAt: true,
          },
        });
      } catch {
        pending = await live();
      }
    }

    if (!pending) {
      // The only way here is a row created and consumed between the two reads.
      // Refusing is correct: there is nothing left for this request to spend.
      return reply.status(409).send({
        error: 'That approval was used while this request was being prepared. Try again.',
        code: 'APPROVAL_RACED',
      });
    }

    return reply.status(428).send({
      error:
        'This action needs your approval. Run the command below in your own terminal; '
        + 'the password is typed there, not here.',
      code: 'APPROVAL_REQUIRED',
      approvalId: pending.id,
      summary: pending.summary,
      resourceId: pending.resourceId ?? resourceId,
      resourceLabel: pending.resourceLabel ?? resourceLabel,
      expiresAt: pending.expiresAt.toISOString(),
      command: `charitypilot-mcp approve ${pending.id} --realm operator`,
    });
  };
}
