import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ComplaintRecoveryPreparationStore } from '../apps/api/src/services/complaint-recovery-preparation-store.ts';
import { RecoveryAuthorityJournal } from '../apps/api/src/services/recovery-authority-journal.ts';
import { S3AuthorityObjectStore } from '../apps/api/src/services/recovery-authority-s3.ts';
import { reserveRecoveryOperation, validateRecoveryControlValue } from '../apps/api/src/services/recovery-operation-reservation.ts';
import { preserveRecoveryPreparation } from '../apps/api/src/services/recovery-preparation-envelope.ts';
import { publishVerifiedComplaintPreparation } from '../apps/api/src/services/publish-verified-complaint-preparation.ts';
import { readCommittedComplaintOutcome } from '../apps/api/src/services/complaint-recovery-outcome.ts';
import { preserveRecoveryOutcome } from '../apps/api/src/services/recovery-outcome-envelope.ts';
import { publishVerifiedComplaintOutcome } from '../apps/api/src/services/publish-verified-complaint-outcome.ts';
import { releaseCommittedComplaintOperation } from '../apps/api/src/services/release-complaint-recovery-operation.ts';
import { executePublishedComplaintOperation } from '../apps/api/src/services/execute-published-complaint-operation.ts';
import { ComplaintHoldRecoveryPreparationStore } from '../apps/api/src/services/complaint-hold-recovery-preparation-store.ts';

// Disposable fixture only: real PostgreSQL and crypto, synthetic S3/KMS transport.
// This proves the complaint gate, not provider custody or all-writer fencing.
const prisma = new PrismaClient({ datasources: { db: { url: readFileSync(0, 'utf8').trim() } } });
const retainedKeys = new Map();
try {
  const binding = { installationId: 'protocol-install', organisationId: 'a' };
  const context = { ...binding, operationId: 'protocol-operation', writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  // Synthetic activation only. Production has no supported activation path yet.
  await prisma.$executeRaw`INSERT INTO "ComplaintRecoveryEnforcement"
    (id,"organisationId","installationId","writerId","writerEpoch") VALUES ('protocol','a','protocol-install','host-a',1)`;
  await assert.rejects(prisma.complaintPurgeClaim.create({ data: { organisationId: 'a', actorUserId: 'admin-a',
    authorizationId: 'recovery-protocol-authority', complaintId: 'recovery-protocol' } }), /recovery execution/);
  const capture = await new ComplaintRecoveryPreparationStore(prisma).capture('a', 'admin-a', {
    installationId: binding.installationId, operationId: context.operationId, writerEpoch: 1,
    authorizationId: 'recovery-protocol-authority', sourceRevision: context.sourceRevision });
  const preparation = await prisma.complaintRecoveryPreparation.findUniqueOrThrow({ where: { id: capture.id } });
  assert.equal(await prisma.complaintPurgeClaim.count({ where: { complaintId: 'recovery-protocol' } }), 0);
  const keys = {
    async generate(ctx) {
      const key = randomBytes(32), wrappedKey = randomBytes(48).toString('base64');
      retainedKeys.set(wrappedKey, { key: Buffer.from(key), context: JSON.stringify(ctx) });
      return { key, wrappedKey, keyId: context.keyId };
    },
    async unwrap(wrappedKey, ctx) {
      const saved = retainedKeys.get(wrappedKey); assert.equal(saved.context, JSON.stringify(ctx));
      return { key: Buffer.from(saved.key), keyId: context.keyId };
    },
  };
  const config = { ...binding, accountId: '123456789012', bucket: 'synthetic-protocol-proof',
    kmsKeyArn: context.keyId.replaceAll('1111', '2222'), replayKeyArn: context.keyId };
  const initial = { ...binding, generation: 0, digest: null };
  const headKey = `authority/${binding.installationId}/${binding.organisationId}/head.json`;
  const initialControl = validateRecoveryControlValue({ format: 2, ...initial, writerId: 'host-a',
    writerEpoch: 1, activeOperation: null });
  const objects = new Map([[headKey, { body: JSON.stringify({ ...initialControl,
    publicationId: '11111111-1111-4111-8111-111111111111' }), version: 1 }]]);
  let version = 1, loseHeadAck = false;
  const metadata = { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const tag = body => `"${createHash('sha256').update(body).digest('hex')}"`;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  client.send = async command => {
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    const old = objects.get(command.input.Key);
    if (command instanceof GetObjectCommand) {
      if (!old) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, VersionId: `v-${old.version}`, ETag: tag(old.body),
        ContentLength: Buffer.byteLength(old.body), Body: Readable.from([Buffer.from(old.body)]) };
    }
    assert.ok(command instanceof PutObjectCommand);
    if ((command.input.IfNoneMatch === '*' && old) || (command.input.IfMatch && command.input.IfMatch !== tag(old.body))) {
      throw { $metadata: { httpStatusCode: 412 } };
    }
    objects.set(command.input.Key, { body: String(command.input.Body), version: ++version });
    if (command.input.Key === headKey && loseHeadAck) { loseHeadAck = false; throw new Error('synthetic lost acknowledgement'); }
    return { ...metadata, VersionId: `v-${version}` };
  };
  const store = new S3AuthorityObjectStore(config, credentials, client);
  const journal = new RecoveryAuthorityJournal(store, binding, initial);
  await reserveRecoveryOperation({ ...binding, writerId: 'host-a', writerEpoch: 1, operationId: context.operationId,
    preparationDigest: capture.digest, expectedGeneration: 0, expectedDigest: null }, store);
  const envelope = await preserveRecoveryPreparation(preparation.facts, context, keys, store);
  const published = await publishVerifiedComplaintPreparation(journal, store, { writerId: 'host-a',
    preparationDigest: capture.digest, expectedGeneration: 0, expectedDigest: null }, context, keys, store);
  const release = () => releaseCommittedComplaintOperation(prisma, journal, store, 'host-a', context, keys, store);
  await assert.rejects(release); // No published committed outcome yet.
  assert.notEqual((await store.readControl()).activeOperation, null);
  const executionData = { preparationId: capture.id, writerId: 'host-a', generation: published.generation,
    entryDigest: published.digest, envelopeDigest: envelope.digest, controlRevision: (await store.readControl()).revision };
  await assert.rejects(prisma.complaintRecoveryExecution.create({ data: executionData }), /atomic claim and outcome/);
  await assert.rejects(prisma.complaintRecoveryExecution.create({ data: { ...executionData, writerId: 'old-host' } }), /exact enforced writer/);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.complaintRecoveryExecution.create({ data: executionData });
    await tx.complaintPurgeClaim.create({ data: { organisationId: 'a', actorUserId: 'admin-a',
      authorizationId: 'recovery-protocol-authority', complaintId: 'recovery-protocol' } });
    // Intentionally omit the outcome: commit must roll deletion and audit back.
  }), /atomic claim and outcome/);
  for (const change of ['owner', 'hold', 'withdraw']) {
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.complaintRecoveryExecution.create({ data: executionData });
      if (change === 'owner') {
        await tx.user.update({ where: { id: 'admin-a' }, data: { role: 'ADMIN' } });
        await tx.user.update({ where: { id: 'ordinary-admin' }, data: { role: 'OWNER' } });
      } else if (change === 'hold') {
        await tx.complaintHoldEvent.create({ data: { organisationId: 'a', complaintId: 'recovery-protocol',
          revision: 1, recordRevision: 2, held: true, actorUserId: 'admin-a', evidenceRef: 'EXECUTION-HOLD-001',
          reason: 'Preserve before the claim' } });
      } else {
        await tx.complaintPurgeAuthorizationWithdrawal.create({ data: { organisationId: 'a',
          authorizationId: 'recovery-protocol-authority', actorUserId: 'admin-a', evidenceRef: 'EXECUTION-WITHDRAW-001',
          reason: 'Withdraw before the claim' } });
      }
      await tx.complaintPurgeClaim.create({ data: { organisationId: 'a', actorUserId: 'admin-a',
        authorizationId: 'recovery-protocol-authority', complaintId: 'recovery-protocol' } });
    }), change === 'owner' ? /active charity Owner/ : change === 'hold' ? /recovery execution/ : /unwithdrawn Owner authority/);
  }
  assert.equal(await prisma.complaintRecoveryExecution.count(), 0);
  assert.equal(await prisma.complaintRecord.count({ where: { id: 'recovery-protocol' } }), 1);
  assert.equal(await prisma.governanceRegisterChangeAudit.count({ where: { recordId: 'recovery-protocol', action: 'DELETE' } }), 0);
  await assert.rejects(prisma.complaintRecoveryEnforcement.delete({ where: { organisationId: 'a' } }), /cannot be removed/);
  await assert.rejects(prisma.complaintRecoveryEnforcement.update({ where: { organisationId: 'a' }, data: { writerEpoch: 2 } }), /cannot be removed/);
  const execute = () => executePublishedComplaintOperation(prisma, journal, store, 'host-a', context, keys, store);
  await assert.rejects(executePublishedComplaintOperation(prisma, journal, store, 'old-host', context, keys, store), /writer or operation mismatch/);
  assert.equal((await execute()).replayed, false);
  assert.equal((await execute()).replayed, true);
  await prisma.$disconnect(); // Evidence must survive reconnection, not process-local cache.
  const outcome = await readCommittedComplaintOutcome(prisma, { ...binding, operationId: context.operationId });
  await preserveRecoveryOutcome(outcome.body, context, keys, store);
  await publishVerifiedComplaintOutcome(journal, store, { writerId: 'host-a', preparationDigest: capture.digest,
    preparationGeneration: published.generation, preparationEntryDigest: published.digest,
    preparationEnvelopeDigest: envelope.digest }, context, keys, store);
  loseHeadAck = true;
  await assert.rejects(release, /unknown/);
  assert.deepEqual(await release(), { released: true, replayed: true, actionAuthorized: false });
  const final = await store.readControl();
  assert.equal(final.activeOperation, null); assert.equal(final.generation, 2);
  assert.equal(await prisma.complaintRecord.count({ where: { id: 'recovery-protocol' } }), 0);
  assert.equal(await prisma.complaintPurgeClaim.count({ where: { complaintId: 'recovery-protocol' } }), 1);
  const staleContext = { ...context, operationId: 'stale-operation' };
  const stale = await new ComplaintRecoveryPreparationStore(prisma).capture('a', 'admin-a', {
    installationId: binding.installationId, operationId: staleContext.operationId, writerEpoch: 1,
    authorizationId: 'recovery-stale-authority', sourceRevision: context.sourceRevision });
  const stalePreparation = await prisma.complaintRecoveryPreparation.findUniqueOrThrow({ where: { id: stale.id } });
  await reserveRecoveryOperation({ ...binding, writerId: 'host-a', writerEpoch: 1, operationId: staleContext.operationId,
    preparationDigest: stale.digest, expectedGeneration: final.generation, expectedDigest: final.digest }, store);
  await preserveRecoveryPreparation(stalePreparation.facts, staleContext, keys, store);
  await publishVerifiedComplaintPreparation(journal, store, { writerId: 'host-a', preparationDigest: stale.digest,
    expectedGeneration: final.generation, expectedDigest: final.digest }, staleContext, keys, store);
  await prisma.complaintHoldEvent.create({ data: { organisationId: 'a', complaintId: 'recovery-stale', revision: 1,
    recordRevision: 2, held: true, actorUserId: 'admin-a', evidenceRef: 'LATER-HOLD-001', reason: 'Preserve after publication' } });
  await assert.rejects(executePublishedComplaintOperation(prisma, journal, store, 'host-a', staleContext, keys, store), /dependencies changed/);
  assert.equal(await prisma.complaintRecord.count({ where: { id: 'recovery-stale' } }), 1);
  assert.equal(await prisma.complaintRecoveryExecution.count({ where: { preparationId: stale.id } }), 0);
  assert.equal((await store.readControl()).activeOperation.operationId, staleContext.operationId);
  const holdPreparations = new ComplaintHoldRecoveryPreparationStore(prisma);
  const holdInput = { installationId: binding.installationId, operationId: 'hold-release-operation', writerEpoch: 1,
    sourceRevision: context.sourceRevision, expectedRecordRevision: 2, expectedHoldRevision: 1, held: false,
    evidenceRef: 'RELEASE-REVIEW-001', reason: 'Synthetic release review for recovery' };
  await assert.rejects(holdPreparations.capture('a', 'recovery-stale', 'member-a', holdInput), /administrator/);
  const holdCapture = await holdPreparations.capture('a', 'recovery-stale', 'ordinary-admin', holdInput);
  assert.equal(holdCapture.actionAuthorized, false);
  assert.equal((await holdPreparations.capture('a', 'recovery-stale', 'ordinary-admin', holdInput)).id, holdCapture.id);
  await assert.rejects(holdPreparations.capture('a', 'recovery-stale', 'ordinary-admin', { ...holdInput, reason: 'Different review must not replace original' }), /identity changed/);
  const holdRow = await prisma.complaintHoldRecoveryPreparation.findUniqueOrThrow({ where: { id: holdCapture.id } });
  await assert.rejects(holdPreparations.capture('b', 'recovery-stale', 'admin-b', holdInput), /dependencies changed/);
  await assert.rejects(holdPreparations.capture('a', 'recovery-stale', 'ordinary-admin', {
    ...holdInput, operationId: 'stale-hold-preparation', expectedHoldRevision: 0 }), /dependencies changed/);
  await assert.rejects(prisma.complaintHoldRecoveryPreparation.create({ data: {
    ...holdRow, id: 'forged-hold-digest', factsDigest: '0'.repeat(64) } }), /identity or dependency mismatch/);
  const changedPrevious = JSON.parse(holdRow.facts);
  changedPrevious.previousHold.reason = 'Substituted previous evidence';
  const changedBody = JSON.stringify(changedPrevious);
  await assert.rejects(prisma.complaintHoldRecoveryPreparation.create({ data: {
    ...holdRow, id: 'forged-previous-hold', facts: changedBody,
    factsDigest: createHash('sha256').update(changedBody).digest('hex') } }), /previous decision mismatch/);
  assert.equal(JSON.parse(holdRow.facts).previousHold.held, true);
  assert.equal(JSON.parse(holdRow.facts).decision.held, false);
  assert.equal(await prisma.complaintHoldEvent.count({ where: { complaintId: 'recovery-stale' } }), 1);
  await assert.rejects(prisma.complaintHoldRecoveryPreparation.update({ where: { id: holdCapture.id }, data: { factsDigest: '0'.repeat(64) } }), /append-only/);
  await assert.rejects(prisma.complaintHoldRecoveryPreparation.delete({ where: { id: holdCapture.id } }), /append-only/);
  process.stdout.write('complaint-recovery-protocol-composition-verified');
} finally {
  for (const value of retainedKeys.values()) value.key.fill(0);
  await prisma.$disconnect();
}
