import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../apps/api/dist/services/document-recovery-preparation.js';
import { readCurrentDocumentByteAuthority } from '../apps/api/dist/services/document-byte-authority-projection.js';

// Only the disposable, loopback-published PostgreSQL fixture created by the
// parent test may invoke this process. Never run against a charity database.
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(process.env.CHARITYPILOT_SYNTHETIC_BYTE_PROOF, '1');
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/charitypilot_byte_authority_[a-f0-9]{32}$/u);
assert.equal(decodeURIComponent(url.username), 'postgres');
const prisma = new PrismaClient();
const iso = (value) => value.toISOString();
const pick = (row, keys) =>
  Object.fromEntries(keys.map((key) => [key, row[key] instanceof Date ? iso(row[key]) : row[key]]));
const documentKeys = [
  'id',
  'organisationId',
  'updatedAt',
  'createdAt',
  'lifecycleStatus',
  'deletedAt',
  'deletionHold',
  'approvalAsserted',
  'approvedByResolutionId',
  'deletedById',
  'removedFromRevision',
  'removalEvidenceRef',
  'recoveryPolicyId',
  'recoveryUntil',
  'recoverySha256',
  'fileUrl',
  'storageProvider',
  'fileSize',
];
const policyKeys = [
  'id',
  'organisationId',
  'recordClass',
  'revision',
  'state',
  'retentionMode',
  'retentionAnchor',
  'retentionDays',
  'recoveryDays',
  'createdById',
  'createdAt',
  'approvedById',
  'approvedAt',
  'approvalEvidenceRef',
];
const authorizationKeys = [
  'id',
  'organisationId',
  'documentId',
  'documentRevision',
  'policyId',
  'actorUserId',
  'evidenceRef',
  'reason',
  'storagePath',
  'provider',
  'sha256',
  'fileSize',
  'recoveryUntil',
  'dispositionPlan',
  'authorizedAt',
];
try {
  assert.equal(await prisma.organisation.count(), 0);
  await prisma.$transaction(async (tx) => {
    await tx.organisation.create({
      data: { id: 'charity', name: 'Synthetic proof charity', documentStorageProvider: 'local' },
    });
    await tx.user.create({
      data: {
        id: 'owner',
        organisationId: 'charity',
        email: 'synthetic-owner@example.invalid',
        name: 'Synthetic Owner',
        passwordHash: 'not-a-login',
        role: 'OWNER',
      },
    });
  });
  const policy = await prisma.dataRetentionPolicyRevision.create({
    data: {
      id: 'policy',
      organisationId: 'charity',
      recordClass: 'VAULT_DRAFT',
      revision: 1,
      state: 'APPROVED',
      retentionMode: 'REVIEW_REQUIRED',
      recoveryDays: 1,
      createdById: 'owner',
      approvedById: 'owner',
      approvedAt: new Date('2026-01-01T00:00:00Z'),
      approvalEvidenceRef: 'TEST-POLICY-001',
    },
  });
  const old = new Date('2026-01-01T00:00:00Z');
  await prisma.document.create({
    data: {
      id: 'doc',
      organisationId: 'charity',
      name: 'Synthetic proof document',
      category: 'OTHER',
      lifecycleStatus: 'DRAFT',
      fileUrl: 'charity/synthetic-proof',
      storageProvider: 'local',
      mimeType: 'application/pdf',
      fileSize: 123,
      createdAt: old,
      updatedAt: old,
    },
  });
  await prisma.$transaction(async (tx) => {
    // This fixture needs an already-expired recovery window. Backdate only
    // its synthetic removed row, then restore the trigger before testing the
    // real authorization, preparation, execution, claim and outcome guards.
    await tx.$executeRawUnsafe(
      'ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard"',
    );
    try {
      await tx.$executeRaw`UPDATE "Document" SET "deletedAt"=${new Date('2026-01-02T00:00:00Z')}, "deletedById"='owner', "removedFromRevision"=${old}, "removalEvidenceRef"='TEST-REMOVAL-001', "recoveryUntil"=${new Date('2026-01-03T00:00:00Z')}, "recoveryPolicyId"='policy', "recoverySha256"=${'a'.repeat(64)}, "updatedAt"=${new Date('2026-01-02T00:00:00Z')} WHERE id='doc'`;
    } finally {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"',
      );
    }
  });
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: 'doc' } });
  const plan = {
    PRIMARY: { disposition: 'DISPOSE', evidenceRef: 'TEST-COPY-001' },
    VERSIONS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    CONFLUENCE: { disposition: 'NOT_APPLICABLE', evidenceRef: 'TEST-COPY-001' },
    EXPORTS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    AUDIT: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    BACKUPS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
  };
  await prisma.documentPurgeAuthorization.create({
    data: {
      id: 'auth',
      organisationId: 'charity',
      documentId: 'doc',
      documentRevision: doc.updatedAt,
      policyId: 'policy',
      actorUserId: 'owner',
      evidenceRef: 'TEST-PURGE-001',
      reason: 'Synthetic claim for database composition proof',
      storagePath: doc.fileUrl,
      provider: 'local',
      sha256: doc.recoverySha256,
      fileSize: doc.fileSize,
      recoveryUntil: doc.recoveryUntil,
      dispositionPlan: plan,
    },
  });
  const auth = await prisma.documentPurgeAuthorization.findUniqueOrThrow({ where: { id: 'auth' } });
  const facts = prepareDocumentRecoveryFacts({
    format: 1,
    action: 'DOCUMENT_PURGE_PREPARATION',
    installationId: 'synthetic-install',
    organisationId: 'charity',
    operationId: 'operation',
    writerEpoch: 1,
    actorUserId: 'owner',
    preparedAt: new Date().toISOString(),
    sourceRevision: 'b'.repeat(40),
    document: pick(doc, documentKeys),
    authorization: pick(auth, authorizationKeys),
    policy: pick(policy, policyKeys),
    removalPolicy: pick(policy, policyKeys),
    removalPolicyWithdrawal: null,
  });
  await prisma.documentRecoveryPreparation.create({
    data: {
      id: 'preparation',
      organisationId: 'charity',
      installationId: 'synthetic-install',
      operationId: 'operation',
      writerEpoch: 1,
      authorizationId: 'auth',
      actorUserId: 'owner',
      facts: facts.body,
      factsDigest: facts.digest,
    },
  });
  await prisma.documentRecoveryEnforcement.create({
    data: {
      id: 'enforcement',
      organisationId: 'charity',
      installationId: 'synthetic-install',
      writerId: 'host',
      writerEpoch: 1,
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.documentRecoveryExecution.create({
      data: {
        id: 'execution',
        preparationId: 'preparation',
        writerId: 'host',
        generation: 1,
        entryDigest: 'c'.repeat(64),
        envelopeDigest: 'd'.repeat(64),
        controlRevision: 'revision',
      },
    });
    await tx.documentPurgeClaim.create({
      data: {
        id: 'claim',
        organisationId: 'charity',
        authorizationId: 'auth',
        documentId: 'doc',
        deletionId: 'job',
        actorUserId: 'owner',
      },
    });
    await tx.documentRecoveryOutcome.create({
      data: { id: 'outcome', preparationId: 'preparation', claimId: 'claim' },
    });
  });
  const request = {
    installationId: 'synthetic-install',
    organisationId: 'charity',
    operationId: 'operation',
  };
  const first = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(first.actionAuthorized, false);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  const second = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(second.digest, first.digest);
  // A later reservation for the same path is a real writer fact that the
  // independent permit publisher must notice rather than reusing the digest.
  await prisma.documentUploadIntent.create({
    data: {
      id: 'late-intent',
      organisationId: 'charity',
      storagePath: 'charity/synthetic-proof',
      provider: 'local',
    },
  });
  const changed = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(changed.actionAuthorized, false);
  assert.notEqual(changed.digest, first.digest);
  process.stdout.write(
    'current-authority-real-postgres-composition=verified; late-writer-digest=changed\n',
  );
} finally {
  await prisma.$disconnect();
}
