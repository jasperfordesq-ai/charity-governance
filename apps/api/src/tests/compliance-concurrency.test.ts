import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'compliance-concurrency-test-secret';

const { ComplianceService } = await import('../services/compliance.service.js');

function falseProfile() {
  return {
    hasPaidStaff: false,
    hasVolunteers: false,
    raisesFundsFromPublic: false,
    worksWithChildrenOrVulnerableAdults: false,
    processesPersonalData: false,
    operatesPremisesOrEvents: false,
    isPublicSectorBody: false,
    usesDataProcessors: false,
  };
}

function expectedSignoffAuditState(signoff: Record<string, any>) {
  return {
    id: signoff.id,
    organisationId: signoff.organisationId,
    reportingYear: signoff.reportingYear,
    status: signoff.status,
    boardMeetingDate: signoff.boardMeetingDate?.toISOString() ?? null,
    minuteReference: signoff.minuteReference,
    approvedByName: signoff.approvedByName,
    approvedByRole: signoff.approvedByRole,
    approvalNotes: signoff.approvalNotes,
    approvedAt: signoff.approvedAt?.toISOString() ?? null,
    revision: signoff.revision,
    approvalSequence: signoff.approvalSequence,
    currentApprovalSnapshotId: signoff.currentApprovalSnapshotId,
    invalidatedAt: signoff.invalidatedAt?.toISOString() ?? null,
    invalidationReason: signoff.invalidationReason,
    invalidatedById: signoff.invalidatedById,
    updatedById: signoff.updatedById,
    createdAt: signoff.createdAt.toISOString(),
    updatedAt: signoff.updatedAt.toISOString(),
  };
}

function buildHarness() {
  const standard = {
    id: 'standard-1',
    principleId: 'principle-1',
    code: '1.1',
    title: 'Know the charitable purpose',
    isCore: true,
    isAdditional: false,
    sortOrder: 1,
    principle: {
      id: 'principle-1',
      number: 1,
      title: 'Advancing charitable purpose',
      description: 'Purpose',
      sortOrder: 1,
    },
  };
  let record: Record<string, any> | null = null;
  let signoff: Record<string, any> | null = null;
  const snapshots: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];
  const transactionOptions: unknown[] = [];
  let organisationName = 'Example Charity';
  let plan = 'ESSENTIALS';
  let conditionalObligationProfile = falseProfile();
  let failNextRecordCreateP2002Target: string[] | null = null;
  let clock = Date.parse('2026-07-10T12:00:00.000Z');
  const now = () => new Date(clock += 1_000);

  const withRecordRelations = () => record
    ? { ...record, standard, updatedBy: { id: 'user-1', name: 'Admin' } }
    : null;
  const withSignoffSnapshot = () => signoff
    ? {
        ...signoff,
        currentApprovalSnapshot:
          snapshots.find((snapshot) => snapshot.id === signoff?.currentApprovalSnapshotId) ?? null,
      }
    : null;

  const prisma: Record<string, any> = {
    $queryRaw: async () => [{ id: 'org-1' }],
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: organisationName,
        rcnNumber: 'RCN-1',
        complexity: 'SIMPLE',
        conditionalObligationProfile,
      }),
    },
    subscription: { findUnique: async () => ({ plan }) },
    user: { findUnique: async () => ({ name: 'Admin' }) },
    governanceStandard: {
      findUnique: async () => standard,
      findMany: async () => [standard],
    },
    complianceRecord: {
      findUnique: async () => withRecordRelations(),
      findUniqueOrThrow: async () => withRecordRelations(),
      findMany: async () => (record ? [{ ...record }] : []),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (failNextRecordCreateP2002Target) {
          const target = failNextRecordCreateP2002Target;
          failNextRecordCreateP2002Target = null;
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target },
          });
        }
        record = {
          id: 'record-1',
          createdAt: now(),
          updatedAt: now(),
          ...data,
        };
        return withRecordRelations();
      },
      updateMany: async ({ where, data }: { where: { id: string; revision: number }; data: Record<string, any> }) => {
        if (!record || record.id !== where.id || record.revision !== where.revision) return { count: 0 };
        record = {
          ...record,
          ...data,
          revision: record.revision + (data.revision?.increment ?? 0),
          updatedAt: now(),
        };
        return { count: 1 };
      },
    },
    complianceSignoff: {
      findUnique: async () => withSignoffSnapshot(),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        signoff = { id: 'signoff-1', createdAt: now(), updatedAt: now(), ...data };
        return withSignoffSnapshot();
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        signoff = { ...signoff, ...data, updatedAt: now() };
        return withSignoffSnapshot();
      },
    },
    complianceApprovalSnapshot: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const snapshot = { id: `snapshot-${snapshots.length + 1}`, createdAt: now(), ...data };
        snapshots.push(snapshot);
        return snapshot;
      },
      findFirst: async () => snapshots.at(-1) ?? null,
    },
    complianceAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({ id: `audit-${audits.length + 1}`, ...data });
        return audits.at(-1);
      },
    },
  };
  prisma.$transaction = async (
    callback: (tx: unknown) => Promise<unknown>,
    options: unknown,
  ) => {
    transactionOptions.push(options);
    return callback(prisma);
  };

  return {
    service: new ComplianceService(prisma as never),
    snapshots,
    audits,
    transactionOptions,
    currentRecord: () => record,
    currentSignoff: () => signoff,
    setOrganisationName: (value: string) => { organisationName = value; },
    setPlan: (value: string) => { plan = value; },
    setConditionalObligationProfile: (value: ReturnType<typeof falseProfile>) => {
      conditionalObligationProfile = value;
    },
    failNextRecordCreateWithP2002: (
      target = ['organisationId', 'standardId', 'reportingYear'],
    ) => { failNextRecordCreateP2002Target = target; },
  };
}

test('record revisions reject stale changes while allowing an exact ambiguous retry', async () => {
  const harness = buildHarness();
  const first = await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Trustees reviewed the purpose',
    evidence: 'Board minutes BM-1',
  } as never);
  assert.equal(first.revision, 1);

  const retry = await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Trustees reviewed the purpose',
    evidence: 'Board minutes BM-1',
  } as never);
  assert.equal(retry.revision, 1);
  assert.equal(harness.audits.filter((event) => event.type === 'RECORD_CREATED').length, 1);

  await assert.rejects(
    () => harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
      reportingYear: 2026,
      expectedRevision: 0,
      status: 'WORKING_TOWARDS',
      actionTaken: 'A stale client changed this',
    } as never),
    (error: unknown) =>
      (error as { code?: string }).code === 'COMPLIANCE_RECORD_REVISION_CONFLICT'
      && (error as { details?: { currentRevision?: number } }).details?.currentRevision === 1,
  );
  assert.equal(harness.currentRecord()?.status, 'COMPLIANT');

  const concurrent = await Promise.allSettled([
    harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
      reportingYear: 2026,
      expectedRevision: 1,
      notes: 'Concurrent draft A',
    } as never),
    harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
      reportingYear: 2026,
      expectedRevision: 1,
      notes: 'Concurrent draft B',
    } as never),
  ]);
  const fulfilled = concurrent.filter((result) => result.status === 'fulfilled');
  const rejected = concurrent.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((fulfilled[0] as PromiseFulfilledResult<{ revision: number }>).value.revision, 2);
  assert.equal(
    ((rejected[0] as PromiseRejectedResult).reason as { code?: string }).code,
    'COMPLIANCE_RECORD_REVISION_CONFLICT',
  );
  assert.equal(harness.currentRecord()?.revision, 2);
  assert.ok(['Concurrent draft A', 'Concurrent draft B'].includes(harness.currentRecord()?.notes));
  assert.equal(harness.audits.filter((event) => event.type === 'RECORD_UPDATED').length, 1);
  assert.deepEqual(harness.transactionOptions[0], { isolationLevel: 'Serializable' });
});

test('a first-create P2002 race is retried and resolved through the revision contract', async () => {
  const harness = buildHarness();
  harness.failNextRecordCreateWithP2002();

  const saved = await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Reviewed after a concurrent create race',
    evidence: 'Board minutes BM-1',
  } as never);

  assert.equal(saved.revision, 1);
  assert.equal(harness.transactionOptions.length, 2);
  assert.equal(harness.audits.filter((event) => event.type === 'RECORD_CREATED').length, 1);
});

test('an unrelated P2002 is not hidden by the scoped compliance retry loop', async () => {
  const harness = buildHarness();
  harness.failNextRecordCreateWithP2002(['id']);

  await assert.rejects(
    () => harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
      reportingYear: 2026,
      expectedRevision: 0,
      status: 'COMPLIANT',
    } as never),
    (error: unknown) => (error as { code?: string }).code === 'P2002',
  );
  assert.equal(harness.transactionOptions.length, 1);
});

test('approval is hash-bound, mutation invalidates it, and reapproval retains both immutable snapshots', async () => {
  const harness = buildHarness();
  await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Trustees reviewed the purpose',
    evidence: 'Board minutes BM-1',
  } as never);

  const readiness = await harness.service.getApprovalReadiness('org-1', 2026);
  assert.equal(readiness.ready, true);
  await assert.rejects(
    () => harness.service.upsertSignoff('org-1', 'user-1', {
      reportingYear: 2026,
      expectedRevision: 0,
      expectedEvidenceHash: 'a'.repeat(64),
      status: 'APPROVED',
      boardMeetingDate: '2026-07-10',
      minuteReference: 'BM-1',
      approvedByName: 'Chair',
    } as never),
    (error: unknown) => (error as { code?: string }).code === 'COMPLIANCE_APPROVAL_EVIDENCE_CHANGED',
  );

  const approved = await harness.service.upsertSignoff('org-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    expectedEvidenceHash: readiness.evidenceHash,
    status: 'APPROVED',
    boardMeetingDate: '2026-07-10',
    minuteReference: 'BM-1',
    approvedByName: 'Chair',
  } as never);
  assert.equal(approved.approvalCurrent, true);
  assert.equal(approved.approvalSequence, 1);
  assert.equal(harness.snapshots.length, 1);
  const firstPayload = JSON.stringify(harness.snapshots[0].payload);
  const signoffBeforeInvalidation = { ...harness.currentSignoff()! };

  const amended = await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 1,
    notes: 'A later trustee clarification',
  } as never);
  assert.equal(amended.revision, 2);
  assert.equal(harness.currentSignoff()?.status, 'DRAFT');
  assert.equal(harness.currentSignoff()?.currentApprovalSnapshotId, null);
  assert.equal(harness.currentSignoff()?.invalidationReason, 'RECORD_CHANGED');
  assert.equal(harness.snapshots.length, 1);
  assert.equal(JSON.stringify(harness.snapshots[0].payload), firstPayload);
  const invalidationEvent = harness.audits.find((event) => event.type === 'APPROVAL_INVALIDATED');
  assert.ok(invalidationEvent);
  assert.deepEqual(invalidationEvent.beforeState, expectedSignoffAuditState(signoffBeforeInvalidation));
  assert.deepEqual(invalidationEvent.afterState, {
    ...expectedSignoffAuditState(harness.currentSignoff()!),
    triggeringRecordId: 'record-1',
    triggeringRecordRevision: 2,
  });

  const afterEdit = await harness.service.getApprovalReadiness('org-1', 2026);
  assert.notEqual(afterEdit.evidenceHash, readiness.evidenceHash);
  const reapproved = await harness.service.upsertSignoff('org-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 2,
    expectedEvidenceHash: afterEdit.evidenceHash,
    status: 'APPROVED',
    boardMeetingDate: '2026-07-11',
    minuteReference: 'BM-2',
    approvedByName: 'Chair',
  } as never);
  assert.equal(reapproved.approvalSequence, 2);
  assert.equal(reapproved.currentApproval?.id, 'snapshot-2');
  assert.equal(reapproved.latestApproval?.id, 'snapshot-2');
  assert.equal(harness.snapshots.length, 2);
  assert.equal(JSON.stringify(harness.snapshots[0].payload), firstPayload);
  assert.deepEqual(
    harness.audits.map((event) => event.type),
    ['RECORD_CREATED', 'APPROVAL_GRANTED', 'RECORD_UPDATED', 'APPROVAL_INVALIDATED', 'APPROVAL_GRANTED'],
  );
});

test('getSignoff fails currentness closed when organisation profile or plan changes', async () => {
  const harness = buildHarness();
  await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Trustees reviewed the purpose',
    evidence: 'Board minutes BM-1',
  } as never);
  const readiness = await harness.service.getApprovalReadiness('org-1', 2026);
  await harness.service.upsertSignoff('org-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    expectedEvidenceHash: readiness.evidenceHash,
    status: 'APPROVED',
    boardMeetingDate: '2026-07-10',
    minuteReference: 'BM-1',
    approvedByName: 'Chair',
  } as never);

  assert.equal((await harness.service.getSignoff('org-1', 2026)).approvalCurrent, true);
  harness.setOrganisationName('Renamed Charity');
  const renamed = await harness.service.getSignoff('org-1', 2026);
  assert.equal(renamed.status, 'APPROVED');
  assert.equal(renamed.approvalCurrent, false);
  assert.equal(renamed.currentApproval?.id, 'snapshot-1');
  assert.equal(renamed.latestApproval?.id, 'snapshot-1');

  harness.setOrganisationName('Example Charity');
  harness.setPlan('COMPLETE');
  assert.equal((await harness.service.getSignoff('org-1', 2026)).approvalCurrent, false);

  harness.setPlan('ESSENTIALS');
  harness.setConditionalObligationProfile({ ...falseProfile(), hasVolunteers: true });
  assert.equal((await harness.service.getSignoff('org-1', 2026)).approvalCurrent, false);
});

test('record changes reset BOARD_REVIEW without inventing approval invalidation history', async () => {
  const harness = buildHarness();
  await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    actionTaken: 'Trustees reviewed the purpose',
    evidence: 'Board minutes BM-1',
  } as never);
  await harness.service.upsertSignoff('org-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'BOARD_REVIEW',
    boardMeetingDate: '2026-07-20',
    minuteReference: 'Draft agenda item 4',
    approvedByName: 'Prospective chair',
    approvedByRole: 'Chair',
    approvalNotes: 'Review pack circulated',
  } as never);
  const beforeReset = { ...harness.currentSignoff()! };
  const boardReviewEvent = harness.audits.find(
    (event) => event.type === 'SIGNOFF_UPDATED' && event.toRevision === 1,
  );
  assert.ok(boardReviewEvent);
  assert.equal(boardReviewEvent.beforeState, undefined);
  assert.deepEqual(boardReviewEvent.afterState, expectedSignoffAuditState(beforeReset));

  await harness.service.upsertRecord('org-1', 'standard-1', 'user-1', {
    reportingYear: 2026,
    expectedRevision: 1,
    notes: 'Evidence changed before the meeting',
  } as never);

  const reset = harness.currentSignoff()!;
  assert.equal(reset.status, 'DRAFT');
  assert.equal(reset.invalidatedAt, null);
  assert.equal(reset.invalidationReason, null);
  assert.equal(reset.invalidatedById, null);
  assert.equal(harness.audits.some((event) => event.type === 'APPROVAL_INVALIDATED'), false);
  const resetEvent = harness.audits.at(-1)!;
  assert.equal(resetEvent.type, 'SIGNOFF_UPDATED');
  assert.equal(resetEvent.reason, undefined);
  assert.equal(resetEvent.approvalSnapshotId, null);
  assert.deepEqual(resetEvent.beforeState, expectedSignoffAuditState(beforeReset));
  assert.deepEqual(resetEvent.afterState, {
    ...expectedSignoffAuditState(reset),
    triggeringRecordId: 'record-1',
    triggeringRecordRevision: 2,
  });
});
