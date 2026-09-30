import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/roles.js';
import { AppError, handleError } from '../../utils/errors.js';
import { listDataLifecycleEvidenceChanges } from '../../services/data-lifecycle-evidence-audit.js';

const PAGE_SIZE = 50;
const feedSchema = z.enum([
  'organisation', 'deadlines', 'reminders', 'minute-book', 'document-controls', 'document-downloads',
  'document-visibility', 'risks', 'registers', 'complaint-resolution', 'controls', 'compliance',
  'reports', 'deletions', 'deletion-attempts', 'deletion-recoveries', 'data-requests',
  'data-request-links', 'data-request-targets', 'data-request-responses', 'data-request-coverage',
  'action-approvals', 'connector-actions', 'integrations',
]);
const querySchema = z.object({
  before: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

async function requireAuditReviewWebSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authSession.clientKind !== 'WEB') {
    return reply.status(403).send({ error: 'Review governance audit in the dashboard.', code: 'WEB_SESSION_REQUIRED' });
  }
}

type AuditRow = { id: string; occurredAt?: Date; createdAt?: Date; sequence?: number };
type AuditDelegate = {
  findFirst(args: unknown): Promise<AuditRow | null>;
  findMany(args: unknown): Promise<AuditRow[]>;
};
type FeedConfig = {
  delegate: AuditDelegate;
  orderField: 'occurredAt' | 'createdAt' | 'sequence';
  select: Record<string, boolean>;
  filter?: Record<string, unknown>;
};

const integrationEventTypes = [
  'INTEGRATION_CONNECTED', 'INTEGRATION_SITE_SELECTED', 'INTEGRATION_DISCONNECTED',
  'INTEGRATION_PUBLISH_TARGET_CHANGED', 'INTEGRATION_ENVIRONMENT_DECLARED',
  'INTEGRATION_REAUTHORISATION_REQUIRED',
  'DOCUMENT_PUBLICATION_DEAD_LETTERED', 'CONFLUENCE_ERASURE_REQUESTED',
] as const;

function feedConfig(app: FastifyInstance, feed: Exclude<z.infer<typeof feedSchema>, 'data-request-links'>): FeedConfig {
  // The switch is an allowlist. No table or column name comes from the URL.
  const delegate = (value: unknown) => value as AuditDelegate;
  switch (feed) {
    case 'organisation': return { delegate: delegate(app.prisma.organisationChangeAudit), orderField: 'occurredAt',
      select: { id: true, actorUserId: true, submittedFields: true,
        previousUpdatedAt: true, nextUpdatedAt: true, occurredAt: true } };
    case 'deadlines': return { delegate: delegate(app.prisma.deadlineChangeAudit), orderField: 'occurredAt',
      select: { id: true, deadlineId: true, actorUserId: true, action: true,
        previousState: true, nextState: true, changedFields: true,
        previousUpdatedAt: true, nextUpdatedAt: true, occurredAt: true } };
    case 'reminders': return { delegate: delegate(app.prisma.deadlineReminderAudit), orderField: 'occurredAt',
      // The reminder log contains addresses, titles, provider IDs and errors.
      // This overview exposes only the recorded state transition.
      select: { id: true, reminderId: true, deadlineId: true, previousStatus: true,
        nextStatus: true, reconciliationOutcome: true, occurredAt: true } };
    case 'minute-book': return { delegate: delegate(app.prisma.minuteBookChangeAudit), orderField: 'occurredAt',
      select: { id: true, recordKind: true, recordId: true, action: true, actorUserId: true, occurredAt: true } };
    case 'document-controls': return { delegate: delegate(app.prisma.documentControlAudit), orderField: 'occurredAt',
      select: { id: true, documentId: true, actorUserId: true, kind: true, occurredAt: true } };
    case 'document-downloads': return { delegate: delegate(app.prisma.documentDownloadPreparationAudit), orderField: 'occurredAt',
      select: { id: true, documentId: true, actorUserId: true, visibility: true, occurredAt: true } };
    case 'document-visibility': return { delegate: delegate(app.prisma.documentVisibilityAudit), orderField: 'occurredAt',
      select: { id: true, documentId: true, actorUserId: true, previous: true, next: true, occurredAt: true } };
    case 'risks': return { delegate: delegate(app.prisma.riskChangeAudit), orderField: 'occurredAt',
      select: { id: true, riskId: true, actorUserId: true, action: true, occurredAt: true } };
    case 'registers': return { delegate: delegate(app.prisma.governanceRegisterChangeAudit), orderField: 'occurredAt',
      select: { id: true, recordKind: true, recordId: true, actorUserId: true, action: true,
        previousStatus: true, nextStatus: true, changedFields: true, occurredAt: true } };
    case 'complaint-resolution': return { delegate: delegate(app.prisma.complaintResolutionEvidence), orderField: 'occurredAt',
      // Case references and free-text reasons belong in the restricted review.
      select: { id: true, complaintId: true, actorUserId: true, revision: true,
        recordRevision: true, state: true, occurredAt: true } };
    case 'controls': return { delegate: delegate(app.prisma.riskControlVerification), orderField: 'sequence',
      select: { id: true, sequence: true, riskId: true, actorUserId: true, controlReference: true,
        state: true, verifiedAt: true, riskRevision: true, occurredAt: true } };
    case 'compliance': return { delegate: delegate(app.prisma.complianceAuditEvent), orderField: 'occurredAt',
      // Detailed reasons stay in the restricted compliance audit, not this
      // cross-domain overview's expandable JSON event details.
      select: { id: true, reportingYear: true, type: true, standardId: true, complianceRecordId: true,
        signoffId: true, approvalSnapshotId: true, actorUserId: true, fromRevision: true,
        toRevision: true, occurredAt: true } };
    case 'reports': return { delegate: delegate(app.prisma.complianceReportPreparationAudit), orderField: 'occurredAt',
      select: { id: true, reportingYear: true, actorUserId: true, reportVersion: true,
        audience: true, occurredAt: true } };
    case 'deletions': return {
      delegate: delegate(app.prisma.documentStorageDeletion), orderField: 'createdAt',
      // Keep storage paths, free-text erasure reasons and provider errors out of the overview.
      select: { id: true, provider: true, state: true, requestedById: true,
        terminalReason: true, attempts: true, createdAt: true, processedAt: true,
        activeObjectAbsentAt: true },
    };
    case 'deletion-attempts': return {
      delegate: delegate(app.prisma.documentStorageDeletionAttempt), orderField: 'occurredAt',
      select: { id: true, deletionId: true, provider: true, attemptNumber: true,
        outcome: true, terminalReason: true, activeObjectAbsentAt: true, occurredAt: true },
    };
    case 'deletion-recoveries': return {
      delegate: delegate(app.prisma.documentStorageDeletionRecovery), orderField: 'createdAt',
      // Recovery reasons, operator identities and both paths can contain private data.
      select: { id: true, deletionId: true, actorType: true, actorUserId: true,
        disposition: true, previousAttempts: true, previousTerminalReason: true,
        createdAt: true },
    };
    case 'data-requests': return {
      delegate: delegate(app.prisma.dataLifecycleReviewEvent), orderField: 'occurredAt',
      // Free-text case reasons and evidence references belong in the controlled
      // individual case view, not the cross-domain overview's JSON details.
      select: { id: true, requestId: true, actorUserId: true, previousState: true,
        nextState: true, occurredAt: true },
    };
    case 'data-request-targets': return {
      delegate: delegate(app.prisma.dataLifecycleTargetEvent), orderField: 'occurredAt',
      // Case reasons and evidence references remain in the restricted case history.
      select: { id: true, requestId: true, actorUserId: true, previousTargetAt: true,
        nextTargetAt: true, occurredAt: true },
    };
    case 'data-request-responses': return {
      delegate: delegate(app.prisma.dataLifecycleResponseEvent), orderField: 'occurredAt',
      // The controlled case history holds reasons and evidence references.
      select: { id: true, requestId: true, actorUserId: true, previousResponseAt: true,
        nextResponseAt: true, occurredAt: true },
    };
    case 'data-request-coverage': return {
      delegate: delegate(app.prisma.dataLifecycleCoverageEvent), orderField: 'occurredAt',
      // Only structured scope decisions appear here. Reasons and controlled
      // archive references stay in the restricted individual case history.
      select: { id: true, requestId: true, area: true, disposition: true,
        actorUserId: true, occurredAt: true },
    };
    case 'action-approvals': return {
      delegate: delegate(app.prisma.authActionApprovalAudit), orderField: 'occurredAt',
      // Keep the server-derived record ID for audit correlation. The approval
      // summary can contain personal narrative; digest and session family stay private.
      select: { id: true, approvalId: true, kind: true, actorUserId: true,
        method: true, routePattern: true, resourceId: true, expiresAt: true, occurredAt: true,
        backfilled: true },
    };
    case 'connector-actions': return {
      delegate: delegate(app.prisma.clientActivityEvent), orderField: 'occurredAt',
      // Session IDs and human-supplied reasons stay out of this cross-domain
      // overview. A failed or refused connector write still has an outcome.
      select: { id: true, userId: true, method: true, routePattern: true,
        resourceId: true, statusCode: true, requestId: true, occurredAt: true },
    };
    case 'integrations': return {
      delegate: delegate(app.prisma.securityAuditEvent), orderField: 'occurredAt',
      filter: { type: { in: [...integrationEventTypes] } },
      // Integration audit labels and context can contain site URLs and document names.
      select: { id: true, type: true, actorKind: true, actorUserId: true, occurredAt: true },
    };
  }
}

export async function governanceAuditRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authGuard);

  app.get<{ Params: { feed: string } }>('/:feed', {
    preHandler: [requireAdmin, requireAuditReviewWebSession],
  }, async (request, reply) => {
    try {
      const feed = feedSchema.parse(request.params.feed);
      const { before } = querySchema.parse(request.query);
      const organisationId = request.user.organisationId;
      if (feed === 'data-request-links') {
        return reply.send(await listDataLifecycleEvidenceChanges(app.prisma, organisationId, before));
      }
      const { delegate, orderField, select, filter } = feedConfig(app, feed);
      const anchor = before ? await delegate.findFirst({
        where: { id: before, organisationId, ...filter },
        select: { id: true, [orderField]: true },
      }) : null;
      if (before && !anchor) throw new AppError(404, 'AUDIT_CURSOR_NOT_FOUND', 'Audit cursor not found');

      const anchorValue = anchor?.[orderField];
      const older = anchor ? orderField === 'sequence'
        ? { sequence: { lt: anchorValue } }
        : { OR: [
          { [orderField]: { lt: anchorValue } },
          { [orderField]: anchorValue, id: { lt: anchor.id } },
        ] } : {};
      const rows = await delegate.findMany({
        where: { organisationId, ...filter, ...older },
        orderBy: orderField === 'sequence'
          ? [{ sequence: 'desc' }]
          : [{ [orderField]: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        select,
      });
      const visible = rows.slice(0, PAGE_SIZE).map((row) => {
        if (feed !== 'connector-actions') return row;
        // The activity hook records the literal path for unmatched routes.
        // Do not copy a caller-controlled path into the general audit view.
        const event = row as AuditRow & { routePattern?: string };
        return event.routePattern?.startsWith('(unmatched)')
          ? { ...event, routePattern: '(unmatched)' }
          : event;
      });
      return reply.send({
        data: visible,
        nextCursor: rows.length > PAGE_SIZE ? visible[visible.length - 1].id : null,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      }
      return handleError(reply, error);
    }
  });
}
