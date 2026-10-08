import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../apps/api/dist/services/document-recovery-preparation.js';
import { readClaimedDocumentByteAuthority,
  readCurrentDocumentByteAuthority } from '../apps/api/dist/services/document-byte-authority-projection.js';
import { readCommittedDocumentByteProviderUnknown } from '../apps/api/dist/services/document-byte-provider-unknown.js';
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
  // The existing orphan-cleanup route may remove a no-page row while no
  // recovery enforcement or claim exists. The new fence must preserve it.
  await prisma.documentPublication.create({ data: {
    id: 'ordinary-no-page-orphan', organisationId: 'charity',
    documentId: 'missing-document', provider: 'confluence',
  } });
  await prisma.documentPublication.delete({ where: { id: 'ordinary-no-page-orphan' } });
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
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({
      data: { id: 'mirror-delete-attempt', organisationId: 'charity',
        documentId: 'doc', provider: 'confluence' },
    });
    await tx.documentPublication.delete({ where: { id: 'mirror-delete-attempt' } });
  }), /publication evidence cannot be deleted/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({
      data: { id: 'mirror-redirect-attempt', organisationId: 'charity',
        documentId: 'doc', provider: 'confluence' },
    });
    await tx.documentPublication.update({ where: { id: 'mirror-redirect-attempt' },
      data: { documentId: 'different-document' } });
  }), /publication identity cannot be changed/);
  assert.equal(await prisma.documentPublication.count(), 0);
  // A publication row exists before remote I/O. Even a PENDING row may be a
  // timed-out page/attachment write, so the exact primary claim must refuse
  // it. The rejected transaction rolls back the synthetic mirror and
  // execution, leaving the normal committed-claim proof below untouched.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentPublication.create({
      data: { id: 'mirror-before-claim', organisationId: 'charity',
        documentId: 'doc', provider: 'confluence' },
    });
    await tx.documentRecoveryExecution.create({
      data: { id: 'mirror-test-execution', preparationId: 'preparation',
        writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
        envelopeDigest: 'd'.repeat(64), controlRevision: 'revision' },
    });
    await tx.documentPurgeClaim.create({
      data: { id: 'mirror-test-claim', organisationId: 'charity',
        authorizationId: 'auth', documentId: 'doc', deletionId: 'mirror-test-job',
        actorUserId: 'owner' },
    });
  }), /reconciliation of unresolved publication/);
  assert.equal(await prisma.documentPublication.count(), 0);
  assert.equal(await prisma.documentRecoveryExecution.count(), 0);
  // A stable, named remote copy can be retained under an explicit Owner
  // disposition. The separate Confluence erasure path is after local removal.
  await prisma.documentPublication.create({
    data: { id: 'retained-mirror', organisationId: 'charity',
      documentId: 'doc', provider: 'confluence', state: 'PROCESSED',
      cloudId: 'synthetic-cloud', spaceId: 'synthetic-space', pageId: 'synthetic-page',
      pageTitle: 'Synthetic proof page', publishedAt: new Date(),
      processedAt: new Date(), nextAttemptAt: null },
  });
  const noRetainAuthorization = await prisma.documentPurgeAuthorization.create({ data: {
    id: 'auth-no-retain', organisationId: 'charity', documentId: 'doc',
    documentRevision: doc.updatedAt, policyId: 'policy', actorUserId: 'owner',
    evidenceRef: 'TEST-PURGE-NO-RETAIN', reason: 'Synthetic refused copy plan',
    storagePath: doc.fileUrl, provider: 'local', sha256: doc.recoverySha256,
    fileSize: doc.fileSize, recoveryUntil: doc.recoveryUntil,
    dispositionPlan: { ...plan, CONFLUENCE: {
      disposition: 'NOT_APPLICABLE', evidenceRef: 'TEST-COPY-001' } },
  } });
  const noRetainFacts = prepareDocumentRecoveryFacts({
    format: 1, action: 'DOCUMENT_PURGE_PREPARATION',
    installationId: 'synthetic-install', organisationId: 'charity',
    operationId: 'operation-no-retain', writerEpoch: 1, actorUserId: 'owner',
    preparedAt: new Date().toISOString(), sourceRevision: 'b'.repeat(40),
    document: pick(doc, documentKeys),
    authorization: pick(noRetainAuthorization, authorizationKeys),
    policy: pick(policy, policyKeys), removalPolicy: pick(policy, policyKeys),
    removalPolicyWithdrawal: null,
  });
  await prisma.documentRecoveryPreparation.create({ data: {
    id: 'preparation-no-retain', organisationId: 'charity',
    installationId: 'synthetic-install', operationId: 'operation-no-retain',
    writerEpoch: 1, authorizationId: 'auth-no-retain', actorUserId: 'owner',
    facts: noRetainFacts.body, factsDigest: noRetainFacts.digest,
  } });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentRecoveryExecution.create({ data: {
      id: 'execution-no-retain', preparationId: 'preparation-no-retain',
      writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), controlRevision: 'revision',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'claim-no-retain', organisationId: 'charity',
      authorizationId: 'auth-no-retain', documentId: 'doc',
      deletionId: 'job-no-retain', actorUserId: 'owner',
    } });
  }), /approved retention of identified external copy/);
  // Reservation is written before upload bytes. The claim must refuse a
  // still-unresolved reservation for its exact provider and object path.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentUploadIntent.create({ data: {
      id: 'reserved-before-claim', organisationId: 'charity',
      storagePath: 'charity/synthetic-proof', provider: 'local',
    } });
    await tx.documentRecoveryExecution.create({ data: {
      id: 'reserved-test-execution', preparationId: 'preparation',
      writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), controlRevision: 'revision',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'reserved-test-claim', organisationId: 'charity',
      authorizationId: 'auth', documentId: 'doc',
      deletionId: 'reserved-test-job', actorUserId: 'owner',
    } });
  }), /reconciliation of unresolved upload intent/);
  assert.equal(await prisma.documentUploadIntent.count(), 0);
  // An ATTACHED intent for another live document on the same object is not
  // the historical reservation for the document being purged.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.document.create({ data: {
      id: 'other-doc', organisationId: 'charity', name: 'Other synthetic document',
      category: 'OTHER', lifecycleStatus: 'DRAFT',
      fileUrl: 'charity/synthetic-proof', storageProvider: 'local',
      fileSize: 123, mimeType: 'application/pdf',
    } });
    await tx.documentUploadIntent.create({ data: {
      id: 'other-attached-intent', organisationId: 'charity',
      storagePath: 'charity/synthetic-proof', provider: 'local',
    } });
    await tx.documentUploadIntent.update({ where: { id: 'other-attached-intent' },
      data: { state: 'ATTACHED', documentId: 'other-doc' } });
    await tx.documentRecoveryExecution.create({ data: {
      id: 'other-test-execution', preparationId: 'preparation',
      writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), controlRevision: 'revision',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'other-test-claim', organisationId: 'charity',
      authorizationId: 'auth', documentId: 'doc',
      deletionId: 'other-test-job', actorUserId: 'owner',
    } });
  }), /reconciliation of unresolved upload intent/);
  assert.equal(await prisma.documentUploadIntent.count(), 0);
  // The original upload intent attached to this same document is historical
  // evidence and must not strand its authorized purge. Roll back the
  // successful synthetic transition so the main claim can proceed below.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.documentUploadIntent.create({ data: {
      id: 'attached-before-claim', organisationId: 'charity',
      storagePath: 'charity/synthetic-proof', provider: 'local',
    } });
    await tx.documentUploadIntent.update({ where: { id: 'attached-before-claim' },
      data: { state: 'ATTACHED', documentId: 'doc' } });
    await tx.documentRecoveryExecution.create({ data: {
      id: 'attached-test-execution', preparationId: 'preparation',
      writerId: 'host', generation: 1, entryDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), controlRevision: 'revision',
    } });
    await tx.documentPurgeClaim.create({ data: {
      id: 'attached-test-claim', organisationId: 'charity',
      authorizationId: 'auth', documentId: 'doc',
      deletionId: 'attached-test-job', actorUserId: 'owner',
    } });
    assert.ok(await tx.documentStorageDeletion.findUnique({
      where: { id: 'attached-test-job' }, select: { id: true },
    }));
    throw new Error('rollback-attached-proof');
  }), /rollback-attached-proof/);
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
  }), /fenced by primary purge/);
  await assert.rejects(prisma.documentStorageDeletion.create({ data: {
    id: 'alias-after-claim', organisationId: 'charity',
    storagePath: 'charity/synthetic-proof', provider: 'local',
  } }), /fenced by primary purge target/);
  await assert.rejects(prisma.documentPublication.update({
    where: { id: 'retained-mirror' }, data: { pageTitle: 'Unexpected republish' },
  }), /fenced by primary purge/);
  await prisma.documentPublication.update({ where: { id: 'retained-mirror' },
    data: { state: 'RETIRED', retiredAt: new Date(), nextAttemptAt: null },
  });
  assert.equal(await prisma.documentPublication.count(), 1);
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
  // A later reservation for the same object is refused before bytes can be
  // written. A changed retained-copy fact still changes current authority.
  await assert.rejects(prisma.documentUploadIntent.create({
    data: {
      id: 'late-intent',
      organisationId: 'charity',
      storagePath: 'charity/synthetic-proof',
      provider: 'local',
    },
  }), /upload intent is fenced by primary purge/);
  await prisma.documentPublication.update({ where: { id: 'retained-mirror' },
    data: { retiredStoragePath: 'charity/synthetic-proof' },
  });
  const changed = await readCurrentDocumentByteAuthority(prisma, request);
  assert.equal(changed.actionAuthorized, false);
  assert.notEqual(changed.digest, first.digest);
  assert.notEqual(changed.localCopyObservationDigest, first.localCopyObservationDigest);
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
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE cp_fixture`;
    await tx.$queryRaw`SELECT public."DocumentByteProviderAttempt_start"('lease', ${attempt})`;
  }));
  await assert.rejects(prisma.$executeRaw`UPDATE "DocumentByteProviderAttempt"
    SET "decisionEntryDigest"=${'2'.repeat(64)} WHERE "leaseId"='lease'`,
  /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "DocumentByteProviderAttempt"
    WHERE "leaseId"='lease'`, /append-only/);
  // Exercise the exact Prisma query and bound values used by the publisher,
  // against the fully migrated database. A copied SQL fixture alone would not
  // catch a broken production INSERT. Roll the synthetic attempt back.
  const claimedAt = new Date('2026-10-07T12:00:00Z');
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.document.create({ data: {
      id: 'upload-service-proof-doc', organisationId: 'charity',
      name: 'Synthetic upload intent document', category: 'OTHER',
      lifecycleStatus: 'DRAFT', fileUrl: 'charity/upload-service-proof',
      storageProvider: 'local', mimeType: 'application/pdf', fileSize: 5,
    } });
    await tx.documentPublication.create({ data: {
      id: 'upload-service-proof', organisationId: 'charity',
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
    assert.equal(saved.organisationId, 'charity');
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
      id: 'page-service-integration', organisationId: 'charity',
      provider: 'CONFLUENCE', status: 'CONNECTED',
      config: { siteId: 'cloud-1' }, publishSpaceSiteId: 'cloud-1',
      publishSpaceId: 'space-1', publishSpaceKey: 'TEST',
      publishSpaceName: 'Synthetic test space',
    } });
    const doc = await tx.document.create({ data: {
      id: 'page-service-proof-doc', organisationId: 'charity',
      name: 'Synthetic page intent document', category: 'OTHER',
      lifecycleStatus: 'CURRENT', externalPublicationApproved: true,
      externalPublicationSiteId: 'cloud-1', externalPublicationSpaceId: 'space-1',
      fileUrl: 'charity/page-service-proof', storageProvider: 'local',
      mimeType: 'application/pdf', fileSize: 5,
    } });
    await tx.documentPublication.create({ data: {
      id: 'page-service-proof', organisationId: 'charity',
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
    'current-authority-real-postgres-composition=verified; protected-worker-skip=verified; cleanup-alias-fence=verified; upload-intent-fence=verified; publication-upload-intent-service=verified; publication-page-intent-service=verified; copy-evidence-digest=changed; post-claim-local-authority=verified; provider-start-marker=verified; provider-start-race=one-winner; provider-unknown-facts=verified; post-start-ordinary-retry-refused=verified\n',
  );
} finally {
  await prisma.$disconnect();
}
