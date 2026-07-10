import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'export-snapshot-test-secret';

const [
  { default: Fastify },
  { exportRoutes },
  { buildComplianceReportHtml },
  { hashComplianceSnapshot },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/export/index.js'),
  import('../routes/export/compliance-report-html.js'),
  import('../services/compliance-snapshot.js'),
  import('../utils/jwt.js'),
]);

const authHeader = `Bearer ${signAccessToken({
  userId: 'user-1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'session-1',
})}`;

function snapshotPayload() {
  return {
    kind: 'charitypilot.compliance-approval' as const,
    formatVersion: 1 as const,
    evidence: {
      organisation: {
        id: 'org-1',
        name: 'Snapshot Charity <script>alert(1)</script>',
        rcnNumber: 'RCN & 123',
      },
      reportingYear: 2026,
      scope: {
        complexity: 'SIMPLE' as const,
        plan: 'ESSENTIALS' as const,
        conditionalObligationProfile: { hasVolunteers: true },
      },
      matrixLastChecked: '2026-07-10',
      standards: [
        {
          principle: { id: 'principle-1', number: 1, title: 'Purpose <one>', sortOrder: 1 },
          standard: {
            id: 'standard-1',
            code: '1.1',
            title: 'Governance & purpose',
            isCore: true,
            isAdditional: false,
            sortOrder: 1,
          },
          record: {
            id: 'record-1',
            revision: 3,
            status: 'COMPLIANT' as const,
            actionTaken: 'Trustees <reviewed>',
            evidence: 'Minute & pack',
            notes: 'SECRET INTERNAL NOTE MUST NOT RENDER',
            explanationIfNA: null,
            updatedAt: '2026-07-09T09:30:00.000Z',
            updatedById: 'user-1',
          },
        },
      ],
      readiness: {
        ready: true,
        missingRecords: [],
        missingEvidence: [],
        missingExplanations: [],
        profileIssues: [],
        conditionalReviewItems: [],
        matrixReviewItems: [
          {
            standardCode: '1.1',
            matrixEntryId: 'matrix-1',
            commencementStatus: 'in_force' as const,
            boardApproval: 'required' as const,
            professionalReview: ['governance_expert' as const],
            sourceRefs: [
              {
                name: 'Snapshot source <trusted>',
                owner: 'Snapshot owner & regulator',
                url: 'https://snapshot.example.test/source?one=1&two=2',
                lastChecked: '2026-07-10',
                note: 'Retained source',
              },
            ],
            applicabilityNote: 'Retained applicability',
            evidenceRequired: ['Board minute'],
          },
        ],
        matrixLastChecked: '2026-07-10',
      },
    },
    approval: {
      sequence: 2,
      boardMeetingDate: '2026-07-09',
      minuteReference: 'BM <4>',
      approvedByName: 'Chair & Trustee',
      approvedByRole: 'Chairperson',
      approvalNotes: 'Approved <carefully>',
      recordedById: 'user-1',
      recordedByName: 'Admin <User>',
      approvedAt: '2026-07-10T11:00:00.000Z',
    },
  };
}

function storedSnapshot(overrides: Record<string, unknown> = {}) {
  const payload = snapshotPayload();
  return {
    id: 'snapshot-<retained>',
    organisationId: 'org-1',
    reportingYear: 2026,
    approvalSequence: 2,
    formatVersion: 1,
    evidenceHash: hashComplianceSnapshot(payload.evidence),
    snapshotHash: hashComplianceSnapshot(payload),
    payload,
    approvedAt: new Date('2026-07-10T11:00:00.000Z'),
    createdById: 'user-1',
    createdByName: 'Admin <User>',
    ...overrides,
  };
}

async function buildApprovedExportApp(
  findFirst: (args: unknown) => Promise<ReturnType<typeof storedSnapshot> | null>,
) {
  const app = Fastify({ logger: false });
  const forbiddenLiveRead = new Proxy(
    {},
    { get: () => async () => { throw new Error('approved export must not read live report data'); } },
  );
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        organisationId: 'org-1',
        role: 'ADMIN',
        emailVerified: true,
      }),
    },
    subscription: {
      findUnique: async () => ({
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: new Date('2026-12-31T00:00:00.000Z'),
        plan: 'COMPLETE',
      }),
    },
    complianceApprovalSnapshot: { findFirst },
    organisation: forbiddenLiveRead,
    governancePrinciple: forbiddenLiveRead,
    governanceStandard: forbiddenLiveRead,
    complianceRecord: forbiddenLiveRead,
    complianceSignoff: forbiddenLiveRead,
    conflictRecord: forbiddenLiveRead,
    riskRecord: forbiddenLiveRead,
    complaintRecord: forbiddenLiveRead,
    fundraisingRecord: forbiddenLiveRead,
    annualReportReadiness: forbiddenLiveRead,
    financialControlReview: forbiddenLiveRead,
  } as never);
  await app.register(exportRoutes);
  return app;
}

test('approved export selects the latest retained tenant snapshot and renders only verified snapshot evidence', async () => {
  let lookup: unknown;
  const app = await buildApprovedExportApp(async (args) => {
    lookup = args;
    return storedSnapshot();
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-report?year=2026&version=approved',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(lookup, {
      where: { organisationId: 'org-1', reportingYear: 2026 },
      orderBy: { approvalSequence: 'desc' },
      select: {
        id: true,
        organisationId: true,
        reportingYear: true,
        approvalSequence: true,
        formatVersion: true,
        evidenceHash: true,
        snapshotHash: true,
        payload: true,
        approvedAt: true,
        createdById: true,
        createdByName: true,
      },
    });
    assert.match(response.body, /Approved Compliance Record Snapshot/);
    assert.match(response.body, /snapshot-&lt;retained&gt;/);
    assert.match(response.body, /Snapshot Charity &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(response.body, /Snapshot source &lt;trusted&gt;/);
    assert.match(response.body, /BM &lt;4&gt;/);
    assert.match(response.body, /Governance registers and data changed after this approval are not part/);
    assert.doesNotMatch(response.body, /SECRET INTERNAL NOTE MUST NOT RENDER/);
    assert.doesNotMatch(response.body, /<script>alert\(1\)<\/script>/);
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
  } finally {
    await app.close();
  }
});

test('snapshot id lookup is tenant-and-year scoped and missing/cross-tenant ids share one response', async () => {
  let lookup: unknown;
  const app = await buildApprovedExportApp(async (args) => {
    lookup = args;
    return null;
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-report?year=2026&snapshotId=other-org-snapshot',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'COMPLIANCE_APPROVAL_SNAPSHOT_NOT_FOUND');
    assert.deepEqual((lookup as { where: unknown }).where, {
      organisationId: 'org-1',
      reportingYear: 2026,
      id: 'other-org-snapshot',
    });
  } finally {
    await app.close();
  }
});

test('approved export fails closed when retained evidence or metadata does not match its hashes', async () => {
  const snapshot = storedSnapshot();
  (snapshot.payload.evidence.standards[0].record as { evidence: string }).evidence = 'tampered';
  const app = await buildApprovedExportApp(async () => snapshot);

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-report?year=2026&version=approved',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, 'COMPLIANCE_SNAPSHOT_INTEGRITY_FAILED');
    assert.doesNotMatch(response.body, /tampered|Board minute|Snapshot Charity/);
  } finally {
    await app.close();
  }
});

test('current export rejects an apparently current signoff when live evidence hash no longer matches', async () => {
  const app = Fastify({ logger: false });
  const approvalSnapshot = {
    id: 'snapshot-old',
    organisationId: 'org-1',
    reportingYear: 2026,
    approvalSequence: 1,
    formatVersion: 1,
    evidenceHash: '0'.repeat(64),
    snapshotHash: '1'.repeat(64),
    payload: {},
    approvedAt: new Date('2026-07-10T11:00:00.000Z'),
    createdById: 'user-1',
    createdByName: 'Admin User',
    createdAt: new Date('2026-07-10T11:00:00.000Z'),
  };
  const principle = {
    id: 'principle-1',
    number: 1,
    title: 'Purpose',
    description: 'Purpose description',
    sortOrder: 1,
  };
  const standard = {
    id: 'standard-1',
    principleId: principle.id,
    principle,
    code: '1.1',
    title: 'Know the purpose',
    isCore: true,
    isAdditional: false,
    sortOrder: 1,
  };
  const record = {
    id: 'record-1',
    organisationId: 'org-1',
    standardId: standard.id,
    reportingYear: 2026,
    status: 'COMPLIANT',
    actionTaken: 'Current changed action',
    evidence: 'Current evidence',
    notes: null,
    explanationIfNA: null,
    revision: 2,
    updatedById: 'user-1',
    updatedAt: new Date('2026-07-10T12:00:00.000Z'),
    standard,
    updatedBy: { id: 'user-1', name: 'Admin User' },
  };

  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        organisationId: 'org-1',
        role: 'ADMIN',
        emailVerified: true,
      }),
    },
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: 'Current Charity',
        rcnNumber: 'RCN 1',
        complexity: 'SIMPLE',
        conditionalObligationProfile: {
          hasPaidStaff: false,
          hasVolunteers: false,
          raisesFundsFromPublic: false,
          worksWithChildrenOrVulnerableAdults: false,
          processesPersonalData: false,
          operatesPremisesOrEvents: false,
          isPublicSectorBody: false,
          usesDataProcessors: false,
        },
      }),
    },
    governancePrinciple: {
      findMany: async () => [{ ...principle, standards: [standard] }],
    },
    governanceStandard: { findMany: async () => [standard] },
    complianceRecord: { findMany: async () => [record] },
    complianceSignoff: {
      findUnique: async () => ({
        id: 'signoff-1',
        organisationId: 'org-1',
        reportingYear: 2026,
        status: 'APPROVED',
        boardMeetingDate: new Date('2026-07-09T00:00:00.000Z'),
        minuteReference: 'BM-4',
        approvedByName: 'Chair',
        approvedByRole: 'Chairperson',
        approvalNotes: null,
        approvedAt: new Date('2026-07-10T11:00:00.000Z'),
        revision: 1,
        approvalSequence: 1,
        currentApprovalSnapshotId: approvalSnapshot.id,
        currentApprovalSnapshot: approvalSnapshot,
        invalidatedAt: null,
        invalidationReason: null,
        invalidatedById: null,
        updatedById: 'user-1',
        createdAt: new Date('2026-07-10T11:00:00.000Z'),
        updatedAt: new Date('2026-07-10T11:00:00.000Z'),
      }),
    },
    complianceApprovalSnapshot: { findFirst: async () => approvalSnapshot },
  } as never);
  await app.register(exportRoutes);

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-report?year=2026',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Previous approval no longer applies to this report/);
    assert.match(response.body, /current evidence changed/i);
    assert.doesNotMatch(response.body, /<strong>Status:<\/strong> Approved<\/p>/);
  } finally {
    await app.close();
  }
});

test('current reports never apply an invalidated approval to live content', () => {
  const baseSignoff = {
    status: 'APPROVED',
    boardMeetingDate: '2026-07-09',
    minuteReference: 'BM-4',
    approvedByName: 'Chair',
    approvedByRole: 'Chairperson',
    approvalNotes: null,
    approvedAt: '2026-07-10T11:00:00.000Z',
  };
  const readiness = {
    ...snapshotPayload().evidence.readiness,
    evidenceHash: 'a'.repeat(64),
  };

  const invalidated = buildComplianceReportHtml(
    { name: 'Current Charity', rcnNumber: 'RCN 1' },
    [],
    new Map(),
    {
      ...baseSignoff,
      status: 'DRAFT',
      approvalCurrent: false,
      invalidatedAt: '2026-07-10T12:00:00.000Z',
      invalidationReason: 'RECORD_CHANGED',
    },
    readiness,
    null,
    2026,
  );
  assert.match(invalidated, /Previous approval no longer applies to this report/);
  assert.match(invalidated, /This generated-time report is not board approved/);
  assert.doesNotMatch(invalidated, /<strong>Status:<\/strong> Approved<\/p>/);

  const current = buildComplianceReportHtml(
    { name: 'Current Charity', rcnNumber: 'RCN 1' },
    [],
    new Map(),
    { ...baseSignoff, approvalCurrent: true },
    readiness,
    null,
    2026,
  );
  assert.match(current, /<strong>Status:<\/strong> Approved<\/p>/);
});
