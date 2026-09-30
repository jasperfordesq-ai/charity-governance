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

// Disposable fixture only: real PostgreSQL and crypto, synthetic S3/KMS transport.
// This proves composition, not provider custody or database execution fencing.
const prisma = new PrismaClient({ datasources: { db: { url: readFileSync(0, 'utf8').trim() } } });
const retainedKeys = new Map();
try {
  const binding = { installationId: 'protocol-install', organisationId: 'a' };
  const context = { ...binding, operationId: 'protocol-operation', writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
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
  await prisma.$transaction(async tx => {
    const claim = await tx.complaintPurgeClaim.create({ data: { organisationId: 'a', actorUserId: 'admin-a',
      authorizationId: 'recovery-protocol-authority', complaintId: 'recovery-protocol' } });
    await tx.complaintRecoveryOutcome.create({ data: { preparationId: capture.id, claimId: claim.id } });
  });
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
  process.stdout.write('complaint-recovery-protocol-composition-verified');
} finally {
  for (const value of retainedKeys.values()) value.key.fill(0);
  await prisma.$disconnect();
}
