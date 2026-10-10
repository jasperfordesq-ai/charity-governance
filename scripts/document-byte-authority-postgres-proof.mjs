import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../apps/api/dist/services/document-recovery-preparation.js';
import { readClaimedDocumentByteAuthority,
  readCurrentDocumentByteAuthority } from '../apps/api/dist/services/document-byte-authority-projection.js';
import { readCommittedDocumentByteProviderUnknown } from '../apps/api/dist/services/document-byte-provider-unknown.js';
import { readRecordedDocumentBytePrimaryObservation } from '../apps/api/dist/services/document-byte-primary-completion.js';
import { DocumentService } from '../apps/api/dist/services/document.service.js';
import { DocumentPublicationService } from '../apps/api/dist/services/document-publication.service.js';

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
  'retentionYears',
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
    await tx.organisation.create({
      data: { id: 'publication-charity', name: 'Synthetic publication charity', documentStorageProvider: 'local' },
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
    await tx.user.create({
      data: {
        id: 'publication-owner',
        organisationId: 'publication-charity',
        email: 'synthetic-publication-owner@example.invalid',
        name: 'Synthetic Publication Owner',
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
  // An unbound charity may remove a no-page queue row while its source
  // document is still live. The publication gate requires that source at
  // INSERT; the purge/cleanup fences must still permit this DELETE.
  await prisma.documentPublication.create({ data: {
    id: 'ordinary-no-page-queue', organisationId: 'charity',
    documentId: 'doc', provider: 'confluence',
  } });
  await prisma.documentPublication.delete({ where: { id: 'ordinary-no-page-queue' } });
  await prisma.$transaction(async (tx) => {
    // This fixture needs an already-expired recovery window. Backdate only
    // its synthetic removed row, then restore the trigger before testing the
    // real authorization, preparation, execution, claim and outcome guards.
    await tx.$executeRaw`ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard"`;
    try {
      await tx.$executeRaw`UPDATE "Document" SET "deletedAt"=${new Date('2026-01-02T00:00:00Z')}, "deletedById"='owner', "removedFromRevision"=${old}, "removalEvidenceRef"='TEST-REMOVAL-001', "recoveryUntil"=${new Date('2026-01-03T00:00:00Z')}, "recoveryPolicyId"='policy', "recoverySha256"=${'a'.repeat(64)}, "updatedAt"=${new Date('2026-01-02T00:00:00Z')} WHERE id='doc'`;
    } finally {
      await tx.$executeRaw`ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"`;
    }
  });
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: 'doc' } });
  const plan = {
    PRIMARY: { disposition: 'DISPOSE', evidenceRef: 'TEST-COPY-001' },
    VERSIONS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    CONFLUENCE: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    EXPORTS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    AUDIT: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
    BACKUPS: { disposition: 'RETAIN_APPROVED', evidenceRef: 'TEST-COPY-001' },
  };
  // Publication and primary purge remain available to an unbound charity.
  // Keep their older safety proofs separate from the recovery-bound charity,
  // which now refuses every publication queue row.
  await prisma.dataRetentionPolicyRevision.create({ data: {
    id: 'publication-policy', organisationId: 'publication-charity',
    recordClass: 'VAULT_DRAFT', revision: 1, state: 'APPROVED',
    retentionMode: 'REVIEW_REQUIRED', recoveryDays: 1,
    createdById: 'publication-owner', approvedById: 'publication-owner',
    approvedAt: old, approvalEvidenceRef: 'TEST-PUBLICATION-POLICY',
  } });
  await prisma.document.create({ data: {
    id: 'publication-purge-doc', organisationId: 'publication-charity',
    name: 'Synthetic publication purge document', category: 'OTHER',
    lifecycleStatus: 'DRAFT', fileUrl: 'publication-charity/purge-proof',
    storageProvider: 'local', mimeType: 'application/pdf', fileSize: 123,
    createdAt: old, updatedAt: old,
  } });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({ data: {
      id: 'identified-copy-probe', organisationId: 'publication-charity',
      documentId: 'publication-purge-doc', provider: 'confluence',
      state: 'PROCESSED', cloudId: 'synthetic-cloud', pageId: 'synthetic-page',
      pageTitle: 'Synthetic page', publishedAt: new Date(),
      processedAt: new Date(), nextAttemptAt: null,
    } });
    await tx.documentPublication.delete({ where: { id: 'identified-copy-probe' } });
  }), /publication evidence cannot be deleted/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({ data: {
      id: 'identity-probe', organisationId: 'publication-charity',
      documentId: 'publication-purge-doc', provider: 'confluence',
    } });
    await tx.documentPublication.update({ where: { id: 'identity-probe' },
      data: { documentId: 'another-document' } });
  }), /publication identity cannot be changed/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({ data: {
      id: 'row-id-probe', organisationId: 'publication-charity',
      documentId: 'publication-purge-doc', provider: 'confluence',
    } });
    await tx.documentPublication.update({ where: { id: 'row-id-probe' },
      data: { id: 'renamed-row-id-probe' } });
  }), /publication row ID cannot be changed/);
  await prisma.documentPublication.create({ data: {
    id: 'pending-publication', organisationId: 'publication-charity',
    documentId: 'publication-purge-doc', provider: 'confluence',
  } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard"`;
    try {
      await tx.$executeRaw`UPDATE "Document" SET "deletedAt"=${new Date('2026-01-02T00:00:00Z')},
        "deletedById"='publication-owner', "removedFromRevision"=${old},
        "removalEvidenceRef"='TEST-PUBLICATION-REMOVAL',
        "recoveryUntil"=${new Date('2026-01-03T00:00:00Z')},
        "recoveryPolicyId"='publication-policy', "recoverySha256"=${'a'.repeat(64)},
        "updatedAt"=${new Date('2026-01-02T00:00:00Z')}
        WHERE id='publication-purge-doc'`;
    } finally {
      await tx.$executeRaw`ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"`;
    }
  });
  const publicationDoc = await prisma.document.findUniqueOrThrow({ where: { id: 'publication-purge-doc' } });
  await prisma.documentPurgeAuthorization.create({ data: {
    id: 'publication-auth', organisationId: 'publication-charity',
    documentId: publicationDoc.id, documentRevision: publicationDoc.updatedAt,
    policyId: 'publication-policy', actorUserId: 'publication-owner',
    evidenceRef: 'TEST-PUBLICATION-PURGE', reason: 'Synthetic pending copy refusal',
    storagePath: publicationDoc.fileUrl, provider: 'local',
    sha256: publicationDoc.recoverySha256, fileSize: publicationDoc.fileSize,
    recoveryUntil: publicationDoc.recoveryUntil, dispositionPlan: plan,
  } });
  await assert.rejects(prisma.documentPurgeClaim.create({ data: {
    id: 'publication-claim', organisationId: 'publication-charity',
    authorizationId: 'publication-auth', documentId: publicationDoc.id,
    deletionId: 'publication-job', actorUserId: 'publication-owner',
  } }), /reconciliation of unresolved publication/);
  assert.equal(await prisma.documentPurgeClaim.count({ where: { organisationId: 'publication-charity' } }), 0);
  const publicationClaimedAt = new Date('2026-10-07T12:00:00Z');
  await prisma.documentPublication.update({ where: { id: 'pending-publication' },
    data: { claimedAt: publicationClaimedAt } });
  await prisma.documentPublication.update({ where: { id: 'pending-publication' },
    data: { remoteWriteStartedAt: publicationClaimedAt } });
  await prisma.documentPublication.update({ where: { id: 'pending-publication' },
    data: { state: 'PROCESSED', cloudId: 'synthetic-cloud', pageId: 'synthetic-page',
      pageTitle: 'Synthetic identified page', publishedAt: new Date(),
      processedAt: new Date(), nextAttemptAt: null, claimedAt: null } });
  await prisma.documentPurgeAuthorization.create({ data: {
    id: 'publication-no-retain-auth', organisationId: 'publication-charity',
    documentId: publicationDoc.id, documentRevision: publicationDoc.updatedAt,
    policyId: 'publication-policy', actorUserId: 'publication-owner',
    evidenceRef: 'TEST-PUBLICATION-NO-RETAIN', reason: 'Synthetic refused retained copy plan',
    storagePath: publicationDoc.fileUrl, provider: 'local',
    sha256: publicationDoc.recoverySha256, fileSize: publicationDoc.fileSize,
    recoveryUntil: publicationDoc.recoveryUntil,
    dispositionPlan: { ...plan, CONFLUENCE: {
      disposition: 'NOT_APPLICABLE', evidenceRef: 'TEST-COPY-001' } },
  } });
  await assert.rejects(prisma.documentPurgeClaim.create({ data: {
    id: 'publication-no-retain-claim', organisationId: 'publication-charity',
    authorizationId: 'publication-no-retain-auth', documentId: publicationDoc.id,
    deletionId: 'publication-no-retain-job', actorUserId: 'publication-owner',
  } }), /approved retention of identified external copy/);
  assert.equal(await prisma.documentPurgeClaim.count({ where: { organisationId: 'publication-charity' } }), 0);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentUploadIntent.create({ data: {
      id: 'publication-reserved-intent', organisationId: 'publication-charity',
      storagePath: publicationDoc.fileUrl, provider: 'local',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'publication-reserved-claim', organisationId: 'publication-charity',
      authorizationId: 'publication-auth', documentId: publicationDoc.id,
      deletionId: 'publication-reserved-job', actorUserId: 'publication-owner',
    } });
  }), /reconciliation of unresolved upload intent/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.document.create({ data: {
      id: 'publication-other-doc', organisationId: 'publication-charity',
      name: 'Other synthetic document', category: 'OTHER', lifecycleStatus: 'DRAFT',
      fileUrl: publicationDoc.fileUrl, storageProvider: 'local',
      fileSize: 123, mimeType: 'application/pdf',
    } });
    await tx.documentUploadIntent.create({ data: {
      id: 'publication-other-intent', organisationId: 'publication-charity',
      storagePath: publicationDoc.fileUrl, provider: 'local',
    } });
    await tx.documentUploadIntent.update({ where: { id: 'publication-other-intent' },
      data: { state: 'ATTACHED', documentId: 'publication-other-doc' } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'publication-other-claim', organisationId: 'publication-charity',
      authorizationId: 'publication-auth', documentId: publicationDoc.id,
      deletionId: 'publication-other-job', actorUserId: 'publication-owner',
    } });
  }), /reconciliation of unresolved upload intent/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentUploadIntent.create({ data: {
      id: 'publication-attached-intent', organisationId: 'publication-charity',
      storagePath: publicationDoc.fileUrl, provider: 'local',
    } });
    await tx.documentUploadIntent.update({ where: { id: 'publication-attached-intent' },
      data: { state: 'ATTACHED', documentId: publicationDoc.id } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'publication-attached-claim', organisationId: 'publication-charity',
      authorizationId: 'publication-auth', documentId: publicationDoc.id,
      deletionId: 'publication-attached-job', actorUserId: 'publication-owner',
    } });
    assert.ok(await tx.documentStorageDeletion.findUnique({
      where: { id: 'publication-attached-job' }, select: { id: true },
    }));
    throw new Error('rollback-attached-publication-proof');
  }), /rollback-attached-publication-proof/);
  assert.equal(await prisma.documentUploadIntent.count({ where: { organisationId: 'publication-charity' } }), 0);
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
  // The interim recovery gate makes a bound-plus-publication fixture
  // impossible. A bound charity cannot queue a page or reserve new bytes.
  await assert.rejects(prisma.documentPublication.create({ data: {
    id: 'mirror-after-binding', organisationId: 'charity',
    documentId: 'doc', provider: 'confluence',
  } }), /publication requires a live same-charity source/);
  await assert.rejects(prisma.documentUploadIntent.create({ data: {
    id: 'reservation-after-binding', organisationId: 'charity',
    storagePath: 'charity/synthetic-proof', provider: 'local',
  } }), /upload reservation requires independent recovery authority/);
  assert.equal(await prisma.documentPublication.count({ where: { organisationId: 'charity' } }), 0);
  assert.equal(await prisma.documentUploadIntent.count(), 0);
  // An ordinary cleanup row aimed at the same provider key could erase the
  // bytes without touching the protected purge job. Refuse the claim even if
  // that other row is pending before the claim transaction starts.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentStorageDeletion.create({ data: {
      id: 'alias-before-claim', organisationId: 'charity',
      storagePath: 'charity/synthetic-proof', provider: 'local',
    } });
    await tx.documentRecoveryExecution.create({ data: {
      id: 'alias-test-execution', preparationId: 'preparation',
      writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), controlRevision: 'revision',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'alias-test-claim', organisationId: 'charity',
      authorizationId: 'auth', documentId: 'doc',
      deletionId: 'alias-test-job', actorUserId: 'owner',
    } });
  }), /reconciliation of matching cleanup job/);
  assert.equal(await prisma.documentStorageDeletion.count(), 0);
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
  await assert.rejects(prisma.documentPublication.create({
    data: { id: 'mirror-after-claim', organisationId: 'charity',
      documentId: 'doc', provider: 'confluence' },
  }), /publication requires a live same-charity source/);
  await assert.rejects(prisma.documentStorageDeletion.create({ data: {
    id: 'alias-after-claim', organisationId: 'charity',
    storagePath: 'charity/synthetic-proof', provider: 'local',
  } }), /fenced by primary purge target/);
  assert.equal(await prisma.documentPublication.count({ where: { organisationId: 'charity' } }), 0);
  const request = {
    installationId: 'synthetic-install',
    organisationId: 'charity',
    operationId: 'operation',
  };
  const first = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(first.actionAuthorized, false);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.match(first.localCopyObservationDigest, /^[a-f0-9]{64}$/);
  assert.match(first.localHoldObservationDigest, /^[a-f0-9]{64}$/);
  const second = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(second.digest, first.digest);
  assert.equal(second.localCopyObservationDigest, first.localCopyObservationDigest);
  assert.equal(second.localHoldObservationDigest, first.localHoldObservationDigest);
  const insertCandidateBinding = (provider) => prisma.$executeRaw`
    INSERT INTO "DocumentBytePermitCandidateBinding"
      (id,"organisationId","preparationId","outcomeId","claimId","deletionId",
       "installationId","operationId","writerId","writerEpoch",
       "permitEntryDigest","permitEnvelopeDigest","outcomeEntryDigest",
       "controlRevision","currentAuthorityDigest",provider,"storagePath",
       "objectSha256","fileSize")
    VALUES ('candidate-binding','charity','preparation','outcome','claim','job',
      'synthetic-install','operation','host',1,
      ${'e'.repeat(64)},${'f'.repeat(64)},${'c'.repeat(64)},
      'synthetic-control-revision',${first.digest},${provider},
      'charity/synthetic-proof',${'a'.repeat(64)},123)`;
  await assert.rejects(insertCandidateBinding('wrong-provider'));
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentBytePermitCandidateBinding"`)[0].count, 0);
  await insertCandidateBinding('local');
  const attempt = randomUUID();
  const attemptHash = createHash('sha256').update(attempt).digest('hex');
  const insertLease = (db, copyDigest = first.localCopyObservationDigest,
    holdDigest = first.localHoldObservationDigest) => db.$executeRaw`
    INSERT INTO "DocumentByteExecutionLease"
      (id,"organisationId","candidateBindingId","deletionId",
       "decisionEntryDigest","decisionEnvelopeDigest","decisionBodyDigest",
       "localCopyObservationDigest","localHoldObservationDigest",
       "providerInventoryDigest","attemptHash")
    VALUES ('lease','charity','candidate-binding','job',
      ${'1'.repeat(64)},${'2'.repeat(64)},${'3'.repeat(64)},
      ${copyDigest},${holdDigest},
      ${'4'.repeat(64)},${attemptHash})`;
  await assert.rejects(insertLease(prisma), /must be consumed in its insertion transaction/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertLease(tx);
    await tx.$executeRaw`UPDATE "DocumentByteExecutionLease"
      SET state='CLAIMED' WHERE id='lease'`;
  }), /outside exact claim/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertLease(tx);
    await tx.$executeRaw`DELETE FROM "DocumentByteExecutionLease" WHERE id='lease'`;
  }), /immutable outside exact claim/);
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET "claimedAt"=now() WHERE id='job'`);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertLease(tx);
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentByteExecutionLease_claim"('lease', ${randomUUID()})`;
  }), /capability does not match/);
  // Exercise the exact runtime grant and same-transaction lease/job claim,
  // then roll back before the inert production-cleanup baseline below.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertLease(tx);
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    const result = await tx.$queryRaw`SELECT public."DocumentByteExecutionLease_claim"('lease', ${attempt}) AS claimed`;
    assert.equal(result[0].claimed, true);
    const claimed = await tx.documentStorageDeletion.findUniqueOrThrow({ where: { id: 'job' } });
    assert.ok(claimed.claimedAt);
    await assert.rejects(tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${attempt})`,
      /lease or target is stale/);
    await assert.rejects(tx.$queryRaw`SELECT public."DocumentByteExecutionLease_claim"('lease', ${attempt})`);
    throw new Error('rollback-exact-lease-proof');
  }), /rollback-exact-lease-proof/);
  assert.equal((await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' }, select: { claimedAt: true },
  })).claimedAt, null);
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentByteExecutionLease"`)[0].count, 0);
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentBytePermitCandidateBinding"
    SET "writerEpoch"=2 WHERE id='candidate-binding'`);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "DocumentBytePermitCandidateBinding"
    WHERE id='candidate-binding'`);
  // A candidate binding is inert: even its exact pending job cannot advance.
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET attempts=1 WHERE id='job'`);
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentBytePermitCandidateBinding"`)[0].count, 1);
  // Scheduler and standalone cleanup share this production SQL claimant.
  // It must skip the enforced purge job without starving an ordinary one.
  await prisma.documentStorageDeletion.create({ data: {
    id: 'ordinary-orphan-job', organisationId: 'charity',
    storagePath: 'charity/unrelated-orphan', provider: 'local',
    nextAttemptAt: new Date('2026-01-01T00:00:00Z'),
  } });
  const erasedPaths = [];
  const cleanup = await new DocumentService(prisma).retryPendingStorageDeletions(
    (provider) => provider === 'local' ? async ({ storagePath }) => {
      erasedPaths.push(storagePath);
      return new Date();
    } : null,
    10,
  );
  assert.equal(cleanup.processed, 1);
  assert.deepEqual(erasedPaths, ['charity/unrelated-orphan']);
  assert.equal((await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'ordinary-orphan-job' }, select: { state: true },
  })).state, 'PROCESSED');
  const protectedJob = await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' }, select: { state: true, claimedAt: true, attempts: true },
  });
  assert.equal(protectedJob.state, 'PENDING');
  assert.equal(protectedJob.claimedAt, null);
  assert.equal(protectedJob.attempts, 0);
  // A bound charity cannot reserve another upload for this object. With
  // publication/copy writers also frozen, the local copy observation stays
  // stable until an independently authorized recovery protocol exists.
  await assert.rejects(prisma.documentUploadIntent.create({
    data: {
      id: 'late-intent',
      organisationId: 'charity',
      storagePath: 'charity/synthetic-proof',
      provider: 'local',
    },
  }), /upload reservation requires independent recovery authority/);
  const changed = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(changed.actionAuthorized, false);
  assert.equal(changed.digest, first.digest);
  assert.equal(changed.localCopyObservationDigest, first.localCopyObservationDigest);
  assert.equal(changed.localHoldObservationDigest, first.localHoldObservationDigest);
  // Simulate a privileged historical repair that bypassed the insertion
  // trigger. The projection and production worker must still refuse this
  // exact-key alias; the trigger is reenabled before either read.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "DocumentStorageDeletion" DISABLE TRIGGER "DocumentStorageDeletion_purge_alias_fence"`;
    try {
      await tx.documentStorageDeletion.create({ data: {
        id: 'privileged-alias', organisationId: 'charity',
        storagePath: 'charity/synthetic-proof', provider: 'local',
        nextAttemptAt: new Date('2026-01-01T00:00:00Z'),
      } });
    } finally {
      await tx.$executeRaw`ALTER TABLE "DocumentStorageDeletion" ENABLE TRIGGER "DocumentStorageDeletion_purge_alias_fence"`;
    }
  });
  await assert.rejects(readCurrentDocumentByteAuthority(prisma, request),
    /changed or cannot be bounded/);
  await prisma.documentStorageDeletion.create({ data: {
    id: 'second-ordinary-job', organisationId: 'charity',
    storagePath: 'charity/second-unrelated-orphan', provider: 'local',
    nextAttemptAt: new Date('2026-01-01T00:00:00Z'),
  } });
  const nextErasedPaths = [];
  const secondCleanup = await new DocumentService(prisma).retryPendingStorageDeletions(
    (provider) => provider === 'local' ? async ({ storagePath }) => {
      nextErasedPaths.push(storagePath);
      return new Date();
    } : null,
    10,
  );
  assert.equal(secondCleanup.processed, 1);
  assert.deepEqual(nextErasedPaths, ['charity/second-unrelated-orphan']);
  assert.equal((await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'privileged-alias' }, select: { state: true, claimedAt: true, attempts: true },
  })).state, 'PENDING');
  // Finish with a committed synthetic lease so the post-claim reader runs
  // through a fresh serializable transaction, not a mock or an uncommitted
  // row. This disposable database is removed by the parent test.
  await prisma.$transaction(async (tx) => {
    // Synthetic fixture cleanup only: production deletion rows are
    // deliberately append-only. The parent destroys this whole temporary DB.
    await tx.$executeRaw`ALTER TABLE "DocumentStorageDeletion" DISABLE TRIGGER "DocumentStorageDeletion_no_delete"`;
    try {
      await tx.documentStorageDeletion.delete({ where: { id: 'privileged-alias' } });
    } finally {
      await tx.$executeRaw`ALTER TABLE "DocumentStorageDeletion" ENABLE TRIGGER "DocumentStorageDeletion_no_delete"`;
    }
  });
  const current = await readCurrentDocumentByteAuthority(prisma, request);
  await prisma.$transaction(async (tx) => {
    await insertLease(tx, current.localCopyObservationDigest,
      current.localHoldObservationDigest);
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    const result = await tx.$queryRaw`SELECT public."DocumentByteExecutionLease_claim"('lease', ${attempt}) AS claimed`;
    assert.equal(result[0].claimed, true);
  });
  const postClaim = await readClaimedDocumentByteAuthority(prisma,
    { ...request, leaseId: 'lease', oneUseAttemptId: attempt });
  assert.equal(postClaim.actionAuthorized, false);
  assert.equal(postClaim.localCopyObservationDigest, current.localCopyObservationDigest);
  assert.equal(postClaim.localHoldObservationDigest, current.localHoldObservationDigest);
  await assert.rejects(readCurrentDocumentByteAuthority(prisma, request),
    /changed or cannot be bounded/);
  await assert.rejects(readClaimedDocumentByteAuthority(prisma,
    { ...request, leaseId: 'lease', oneUseAttemptId: randomUUID() }),
  /changed or cannot be bounded/);
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentByteProviderAttempt"`)[0].count, 0);
  await assert.rejects(readCommittedDocumentByteProviderUnknown(prisma,
    { ...request, leaseId: 'lease' }), /unavailable or mismatched/);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$executeRaw`INSERT INTO "DocumentByteProviderAttempt"
      (id,"leaseId","organisationId","deletionId","decisionEntryDigest",
        "startedTransactionId","startedAt")
      VALUES ('lease','lease','charity','job',${'1'.repeat(64)},txid_current(),now())`;
  }), /permission denied/);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${randomUUID()})`;
  }), /capability does not match/);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    const result = await tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${attempt}) AS started`;
    assert.equal(result[0].started, true);
    // The marker must be durable before any observation: one transaction
    // cannot both start the attempt and report what the provider did.
    await assert.rejects(tx.$queryRaw`SELECT public."DocumentByteProviderObservation_recordAbsent"('lease',
      ${attempt}, clock_timestamp())`, /attempt or target is stale/);
    throw new Error('rollback-provider-start-proof');
  }), /rollback-provider-start-proof/);
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentByteProviderAttempt"`)[0].count, 0);
  // Two separate runtime transactions racing the same one-use capability
  // must leave exactly one durable possible-I/O marker. A future worker must
  // treat the losing exception as a hard stop before any provider call.
  const starts = await Promise.allSettled(Array.from({ length: 2 }, () =>
    prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
      const result = await tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${attempt}) AS started`;
      assert.equal(result[0].started, true);
    }, { maxWait: 15000, timeout: 15000 })));
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter(result => result.status === 'rejected').length, 1);
  const loser = starts.find(result => result.status === 'rejected');
  assert.match(String(loser.reason), /23505|unique constraint|duplicate key/i);
  assert.equal((await prisma.$queryRaw`SELECT count(*)::integer AS count
    FROM "DocumentByteProviderAttempt" WHERE "leaseId"='lease'`)[0].count, 1);
  const started = await prisma.documentByteProviderAttempt.findUniqueOrThrow({
    where: { leaseId: 'lease' },
  });
  const unknown = await readCommittedDocumentByteProviderUnknown(prisma,
    { ...request, leaseId: 'lease' });
  const restrictedUnknown = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    return readCommittedDocumentByteProviderUnknown(tx,
      { ...request, leaseId: 'lease' });
  });
  assert.equal(restrictedUnknown.body, unknown.body);
  const unknownFacts = JSON.parse(unknown.body);
  assert.equal(unknown.actionAuthorized, false);
  assert.equal(unknownFacts.action, 'DOCUMENT_PRIMARY_BYTE_PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(unknownFacts.writerId, 'host');
  assert.equal(unknownFacts.writerEpoch, 1);
  assert.equal(unknownFacts.sourceRevision, 'b'.repeat(40));
  assert.equal(unknownFacts.preparationDigest, facts.digest);
  assert.equal(unknownFacts.decisionBodyDigest, '3'.repeat(64));
  assert.equal(unknownFacts.leaseId, 'lease');
  assert.equal(unknownFacts.deletionId, 'job');
  assert.equal(unknownFacts.startedTransactionId, started.startedTransactionId.toString());
  assert.equal(unknown.digest, createHash('sha256').update(unknown.body).digest('hex'));
  assert.doesNotMatch(unknown.body, /charity\/synthetic-proof|synthetic-only/);
  await assert.rejects(readCommittedDocumentByteProviderUnknown(prisma,
    { ...request, operationId: 'other-operation', leaseId: 'lease' }), /unavailable or mismatched/);
  assert.equal(started.organisationId, 'charity');
  assert.equal(started.deletionId, 'job');
  assert.equal(started.decisionEntryDigest, '1'.repeat(64));
  const protectedClaimedAt = (await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' }, select: { claimedAt: true },
  })).claimedAt;
  assert.ok(protectedClaimedAt instanceof Date);
  // A committed start marker means provider I/O may have happened. The
  // ordinary worker and result helpers must not turn that uncertainty into
  // an automatic retry or a completed deletion, even after another job runs.
  await assert.rejects(new DocumentService(prisma).markStorageDeletionProcessed(
    'job', protectedClaimedAt, new Date(),
  ), /requires independent permit/);
  await assert.rejects(new DocumentService(prisma).recordStorageDeletionFailure(
    'job', new Error('provider acknowledgement lost'), protectedClaimedAt,
  ), /requires independent permit/);
  await prisma.documentStorageDeletion.create({ data: {
    id: 'post-start-ordinary-job', organisationId: 'charity',
    storagePath: 'charity/post-start-unrelated-orphan', provider: 'local',
    nextAttemptAt: new Date('2026-01-01T00:00:00Z'),
  } });
  const postStartErasedPaths = [];
  const postStartCleanup = await new DocumentService(prisma).retryPendingStorageDeletions(
    (provider) => provider === 'local' ? async ({ storagePath }) => {
      postStartErasedPaths.push(storagePath);
      return new Date();
    } : null,
    10,
  );
  assert.equal(postStartCleanup.processed, 1);
  assert.deepEqual(postStartErasedPaths, ['charity/post-start-unrelated-orphan']);
  const unresolved = await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' },
    select: { state: true, attempts: true, claimedAt: true, processedAt: true },
  });
  assert.equal(unresolved.state, 'PENDING');
  assert.equal(unresolved.attempts, 0);
  assert.equal(unresolved.claimedAt?.getTime(), protectedClaimedAt.getTime());
  assert.equal(unresolved.processedAt, null);
  // A primary-absence observation is the runtime's only write after the
  // marker. It needs the same one-use capability, a provider time after the
  // committed start and no later than now, and it must leave the job and its
  // byte fence exactly as UNKNOWN left them.
  const observeAs = (capability, at) => prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    return tx.$queryRaw`SELECT public."DocumentByteProviderObservation_recordAbsent"('lease',
      ${capability}, ${at}::timestamptz) AS recorded`;
  });
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$executeRaw`INSERT INTO "DocumentByteProviderObservation"
      (id,"leaseId","attemptId","organisationId","deletionId","decisionEntryDigest",
        outcome,"providerObservedAt","observedTransactionId","recordedAt")
      VALUES ('lease','lease','lease','charity','job',${'1'.repeat(64)},
        'PRIMARY_ACTIVE_OBJECT_ABSENT',now(),txid_current(),now())`;
  }), /permission denied/);
  const afterStart = new Date(started.startedAt.getTime() + 1).toISOString();
  await assert.rejects(observeAs(randomUUID(), afterStart), /capability does not match/);
  await assert.rejects(observeAs('not-a-capability', afterStart), /Invalid document byte attempt capability/);
  await assert.rejects(observeAs(attempt, null), /Invalid document byte provider observation time/);
  await assert.rejects(observeAs(attempt, 'infinity'), /Invalid document byte provider observation time/);
  await assert.rejects(observeAs(attempt,
    new Date(started.startedAt.getTime() - 1).toISOString()), /attempt or target is stale/);
  await assert.rejects(observeAs(attempt,
    new Date(Date.now() + 60_000).toISOString()), /attempt or target is stale/);
  assert.equal(await prisma.documentByteProviderObservation.count(), 0);
  // No completion can be recorded before an observation exists.
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentBytePrimaryCompletion_record"('lease', ${attempt},
      ${'3'.repeat(64)}, ${'4'.repeat(64)}, ${'5'.repeat(64)})`;
  }), /requires a recorded provider observation/);
  const recordedAbsent = await observeAs(attempt, afterStart);
  assert.equal(recordedAbsent[0].recorded, true);
  const absence = await prisma.documentByteProviderObservation.findUniqueOrThrow({
    where: { leaseId: 'lease' },
  });
  assert.equal(absence.attemptId, 'lease');
  assert.equal(absence.deletionId, 'job');
  assert.equal(absence.organisationId, 'charity');
  assert.equal(absence.decisionEntryDigest, started.decisionEntryDigest);
  assert.equal(absence.outcome, 'PRIMARY_ACTIVE_OBJECT_ABSENT');
  assert.equal(absence.providerObservedAt.toISOString(), afterStart);
  assert.notEqual(absence.observedTransactionId, started.startedTransactionId);
  assert.ok(absence.recordedAt.getTime() >= absence.providerObservedAt.getTime());
  await assert.rejects(observeAs(attempt, afterStart), /23505|unique constraint|duplicate key/i);
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentByteProviderObservation"
    SET outcome='PRIMARY_ACTIVE_OBJECT_ABSENT' WHERE "leaseId"='lease'`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "DocumentByteProviderObservation"
    WHERE "leaseId"='lease'`, /append-only/);
  const stillUnresolved = await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' },
    select: { state: true, attempts: true, claimedAt: true, processedAt: true },
  });
  assert.deepEqual(stillUnresolved, unresolved);
  await assert.rejects(new DocumentService(prisma).markStorageDeletionProcessed(
    'job', protectedClaimedAt, absence.providerObservedAt,
  ), /requires independent permit/);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${attempt})`;
  }));
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentByteProviderAttempt"
    SET "decisionEntryDigest"=${'2'.repeat(64)} WHERE "leaseId"='lease'`,
  /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "DocumentByteProviderAttempt"
    WHERE "leaseId"='lease'`, /append-only/);
  // Completion is the runtime's only way to move a protected job to
  // PROCESSED. It needs the same one-use capability, an observation recorded
  // in an earlier transaction and the digests of the authenticated
  // independent completion entry. The exact production reader runs first.
  const recorded = await readRecordedDocumentBytePrimaryObservation(prisma,
    { ...request, leaseId: 'lease' });
  assert.equal(recorded.deletionId, 'job');
  assert.equal(recorded.providerObservedAt.toISOString(), afterStart);
  assert.equal(recorded.actionAuthorized, false);
  const completionDigests = ['3'.repeat(64), '4'.repeat(64), '5'.repeat(64)];
  const completeAs = (capability, digests = completionDigests) => prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    return tx.$queryRaw`SELECT public."DocumentBytePrimaryCompletion_record"('lease', ${capability},
      ${digests[0]}, ${digests[1]}, ${digests[2]}) AS recorded`;
  });
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$executeRaw`INSERT INTO "DocumentBytePrimaryCompletion"
      (id,"leaseId","observationId","organisationId","deletionId","decisionEntryDigest",
        "completionEntryDigest","completionEnvelopeDigest","completionBodyDigest",
        scope,"completedTransactionId","recordedAt")
      VALUES ('lease','lease','lease','charity','job',${started.decisionEntryDigest},
        ${'3'.repeat(64)},${'4'.repeat(64)},${'5'.repeat(64)},
        'PRIMARY_ACTIVE_OBJECT_ONLY',txid_current(),now())`;
  }), /permission denied/);
  await assert.rejects(completeAs(randomUUID()), /capability does not match/);
  await assert.rejects(completeAs('not-a-capability'), /Invalid document byte attempt capability/);
  await assert.rejects(completeAs(attempt, ['not-a-digest', '4'.repeat(64), '5'.repeat(64)]),
    /Invalid document byte completion digest/);
  // A completion row written directly by the owner cannot commit unless its
  // job was processed in the same transaction.
  await assert.rejects(prisma.$executeRaw`INSERT INTO "DocumentBytePrimaryCompletion"
    (id,"leaseId","observationId","organisationId","deletionId","decisionEntryDigest",
      "completionEntryDigest","completionEnvelopeDigest","completionBodyDigest",
      scope,"completedTransactionId","recordedAt")
    VALUES ('lease','lease','lease','charity','job',${started.decisionEntryDigest},
      ${'3'.repeat(64)},${'4'.repeat(64)},${'5'.repeat(64)},
      'PRIMARY_ACTIVE_OBJECT_ONLY',0,now())`, /must process its job in the same transaction/);
  // Nor can the owner process the job without a completion row from this
  // transaction: the byte fence still refuses it.
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET state='PROCESSED', "processedAt"=now(), "activeObjectAbsentAt"=${absence.providerObservedAt}
    WHERE id='job'`, /requires independent permit/);
  // With a completion row in the same transaction, the fence permits only
  // the exact processed state: the observed time, a processed time no
  // earlier than the observation, and no other change. Each is rolled back;
  // the first is the positive control.
  const ownerComplete = (update) => prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "DocumentBytePrimaryCompletion"
      (id,"leaseId","observationId","organisationId","deletionId","decisionEntryDigest",
        "completionEntryDigest","completionEnvelopeDigest","completionBodyDigest",
        scope,"completedTransactionId","recordedAt")
      VALUES ('lease','lease','lease','charity','job',${started.decisionEntryDigest},
        ${'3'.repeat(64)},${'4'.repeat(64)},${'5'.repeat(64)},
        'PRIMARY_ACTIVE_OBJECT_ONLY',0,now())`;
    await update(tx);
    throw new Error('rollback-owner-completion-proof');
  });
  await assert.rejects(ownerComplete(tx => tx.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET state='PROCESSED', "processedAt"=clock_timestamp(),
      "activeObjectAbsentAt"=${absence.providerObservedAt}, "claimedAt"=NULL, "nextAttemptAt"=NULL
    WHERE id='job'`), /rollback-owner-completion-proof/);
  await assert.rejects(ownerComplete(tx => tx.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET state='PROCESSED', "processedAt"=clock_timestamp(),
      "activeObjectAbsentAt"=${new Date(absence.providerObservedAt.getTime() + 1)},
      "claimedAt"=NULL, "nextAttemptAt"=NULL
    WHERE id='job'`), /requires independent permit/);
  await assert.rejects(ownerComplete(tx => tx.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET state='PROCESSED', "processedAt"=${new Date(absence.recordedAt.getTime() - 1000)},
      "activeObjectAbsentAt"=${absence.providerObservedAt}, "claimedAt"=NULL, "nextAttemptAt"=NULL
    WHERE id='job'`), /requires independent permit/);
  await assert.rejects(ownerComplete(tx => tx.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET state='PROCESSED', "processedAt"=clock_timestamp(),
      "activeObjectAbsentAt"=${absence.providerObservedAt}, "claimedAt"=NULL, "nextAttemptAt"=NULL,
      reason='synthetic-change'
    WHERE id='job'`), /requires independent permit/);
  // An observation recorded in the completing transaction cannot back it.
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`ALTER TABLE "DocumentByteProviderObservation" DISABLE TRIGGER "DocumentByteProviderObservation_guard"`;
    await tx.$executeRaw`DELETE FROM "DocumentByteProviderObservation" WHERE "leaseId"='lease'`;
    await tx.$executeRaw`ALTER TABLE "DocumentByteProviderObservation" ENABLE TRIGGER "DocumentByteProviderObservation_guard"`;
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentByteProviderObservation_recordAbsent"('lease',
      ${attempt}, ${afterStart}::timestamptz)`;
    await assert.rejects(tx.$queryRaw`SELECT public."DocumentBytePrimaryCompletion_record"('lease',
      ${attempt}, ${'3'.repeat(64)}, ${'4'.repeat(64)}, ${'5'.repeat(64)})`,
    /observation, lease or target is stale/);
    throw new Error('rollback-same-transaction-observation-proof');
  }), /rollback-same-transaction-observation-proof/);
  assert.equal(await prisma.documentBytePrimaryCompletion.count(), 0);
  assert.equal((await prisma.documentByteProviderObservation.findUniqueOrThrow({
    where: { leaseId: 'lease' } })).observedTransactionId, absence.observedTransactionId);
  assert.deepEqual(await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' },
    select: { state: true, attempts: true, claimedAt: true, processedAt: true },
  }), unresolved);
  const completed = await completeAs(attempt);
  assert.equal(completed[0].recorded, true);
  const completion = await prisma.documentBytePrimaryCompletion.findUniqueOrThrow({
    where: { leaseId: 'lease' },
  });
  assert.deepEqual([completion.id, completion.observationId, completion.organisationId,
    completion.deletionId, completion.decisionEntryDigest, completion.completionEntryDigest,
    completion.completionEnvelopeDigest, completion.completionBodyDigest, completion.scope],
  ['lease', 'lease', 'charity', 'job', started.decisionEntryDigest, ...completionDigests,
    'PRIMARY_ACTIVE_OBJECT_ONLY']);
  assert.notEqual(completion.completedTransactionId, absence.observedTransactionId);
  const processed = await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: 'job' },
    select: { state: true, attempts: true, claimedAt: true, processedAt: true,
      activeObjectAbsentAt: true },
  });
  assert.equal(processed.state, 'PROCESSED');
  assert.equal(processed.attempts, 0);
  assert.equal(processed.claimedAt, null, 'the completion row keeps the lease; the job releases its claim');
  assert.equal(processed.activeObjectAbsentAt?.getTime(), absence.providerObservedAt.getTime());
  assert.ok(processed.processedAt.getTime() >= completion.recordedAt.getTime());
  const audit = await prisma.documentStorageDeletionAttempt.findMany({ where: { deletionId: 'job' } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'PROCESSED');
  assert.equal(audit[0].activeObjectAbsentAt?.getTime(), absence.providerObservedAt.getTime());
  // One completion per lease, append-only, and the processed job is terminal.
  await assert.rejects(completeAs(attempt), /stale|23505|unique constraint|duplicate key/i);
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentBytePrimaryCompletion"
    SET scope='PRIMARY_ACTIVE_OBJECT_ONLY' WHERE "leaseId"='lease'`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "DocumentBytePrimaryCompletion"
    WHERE "leaseId"='lease'`, /append-only/);
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentStorageDeletion"
    SET "lastError"='synthetic' WHERE id='job'`, /requires independent permit|terminal/);
  // Exercise the exact Prisma query and bound values used by the publisher,
  // against the fully migrated database. A copied SQL fixture alone would not
  // catch a broken production INSERT. Roll the synthetic attempt back.
  const claimedAt = new Date('2026-10-07T12:00:00Z');
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.document.create({ data: {
      id: 'upload-service-proof-doc', organisationId: 'publication-charity',
      name: 'Synthetic upload intent document', category: 'OTHER',
      lifecycleStatus: 'DRAFT', fileUrl: 'publication-charity/upload-service-proof',
      storageProvider: 'local', mimeType: 'application/pdf', fileSize: 5,
    } });
    await tx.documentPublication.create({ data: {
      id: 'upload-service-proof', organisationId: 'publication-charity',
      documentId: 'upload-service-proof-doc',
    } });
    await tx.documentPublication.update({ where: { id: 'upload-service-proof' },
      data: { claimedAt } });
    const publisher = new DocumentPublicationService(tx);
    assert.equal(await publisher.reserveRemoteWrite('upload-service-proof', claimedAt), true);
    assert.equal(await publisher.attachPublicationPage('upload-service-proof', {
      cloudId: 'cloud-1', spaceId: 'space-1', pageId: 'page-1', pageTitle: 'Synthetic page',
    }, claimedAt), true);
    const claimed = await tx.documentPublication.findUniqueOrThrow({
      where: { id: 'upload-service-proof' },
    });
    const operationId = await publisher.reserveUploadIntent(claimed, {
      cloudId: 'cloud-1', spaceId: 'space-1', pageId: 'page-1',
      filename: 'synthetic.pdf', sha256: 'a'.repeat(64),
    });
    assert.match(operationId, /^[0-9a-f]{32}$/u);
    const saved = await tx.documentPublicationUploadIntent.findUniqueOrThrow({
      where: { id: operationId },
    });
    assert.equal(saved.publicationId, 'upload-service-proof');
    assert.equal(saved.organisationId, 'publication-charity');
    assert.equal(saved.pageId, 'page-1');
    assert.equal(saved.filename, 'synthetic.pdf');
    assert.equal(saved.sha256, 'a'.repeat(64));
    throw new Error('synthetic upload intent proof rollback');
  }), /synthetic upload intent proof rollback/u);
  assert.equal(await prisma.documentPublicationUploadIntent.count(), 0);
  // Exercise the production page-intent method, not a copied INSERT. The
  // target and approval must be current in the fully migrated database.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.organisationIntegration.create({ data: {
      id: 'page-service-integration', organisationId: 'publication-charity',
      provider: 'CONFLUENCE', status: 'CONNECTED',
      config: { siteId: 'cloud-1' }, publishSpaceSiteId: 'cloud-1',
      publishSpaceId: 'space-1', publishSpaceKey: 'TEST',
      publishSpaceName: 'Synthetic test space',
    } });
    const doc = await tx.document.create({ data: {
      id: 'page-service-proof-doc', organisationId: 'publication-charity',
      name: 'Synthetic page intent document', category: 'OTHER',
      lifecycleStatus: 'CURRENT', externalPublicationApproved: true,
      externalPublicationSiteId: 'cloud-1', externalPublicationSpaceId: 'space-1',
      fileUrl: 'publication-charity/page-service-proof', storageProvider: 'local',
      mimeType: 'application/pdf', fileSize: 5,
    } });
    await tx.documentPublication.create({ data: {
      id: 'page-service-proof', organisationId: 'publication-charity',
      documentId: doc.id,
    } });
    await tx.documentPublication.update({ where: { id: 'page-service-proof' },
      data: { claimedAt } });
    const publisher = new DocumentPublicationService(tx);
    assert.equal(await publisher.reserveRemoteWrite('page-service-proof', claimedAt), true);
    const claimed = await tx.documentPublication.findUniqueOrThrow({
      where: { id: 'page-service-proof' },
    });
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    const requestedOperationId = randomBytes(16).toString('hex');
    const operationId = await publisher.reservePageCreateIntent(claimed, {
      operationId: requestedOperationId,
      documentRevision: doc.updatedAt, cloudId: 'cloud-1', spaceId: 'space-1',
      parentPageId: null, title: 'Synthetic page', bodySha256: 'b'.repeat(64),
    });
    assert.equal(operationId, requestedOperationId);
    const saved = await tx.documentPublicationPageCreateIntent.findUniqueOrThrow({
      where: { id: operationId },
    });
    assert.equal(saved.id, requestedOperationId);
    assert.equal(saved.publicationId, 'page-service-proof');
    assert.equal(saved.documentRevision.getTime(), doc.updatedAt.getTime());
    assert.equal(saved.cloudId, 'cloud-1');
    assert.equal(saved.spaceId, 'space-1');
    assert.equal(saved.parentPageId, null);
    assert.equal(saved.title, 'Synthetic page');
    assert.equal(saved.bodySha256, 'b'.repeat(64));
    throw new Error('synthetic page intent proof rollback');
  }), /synthetic page intent proof rollback/u);
  assert.equal(await prisma.documentPublicationPageCreateIntent.count(), 0);
  process.stdout.write(
    'current-authority-real-postgres-composition=verified; protected-worker-skip=verified; cleanup-alias-fence=verified; upload-intent-fence=verified; publication-upload-intent-service=verified; publication-page-intent-service=verified; copy-evidence-digest=stable; post-claim-local-authority=verified; provider-start-marker=verified; provider-start-race=one-winner; provider-unknown-facts=verified; post-start-ordinary-retry-refused=verified; provider-absence-observation=verified; post-observation-fence=unchanged; primary-completion=verified; post-completion-job=terminal\n',
  );
} finally {
  await prisma.$disconnect();
}
