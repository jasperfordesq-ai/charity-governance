// Run only by --runner-purge-worker-proof inside its attested API container.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import safety from '../e2e/helpers/database-safety.cjs';
import { DocumentService } from '../apps/api/src/services/document.service.ts';
import { DocumentRecoveryService } from '../apps/api/src/services/document-recovery.service.ts';
import { DocumentPurgeService } from '../apps/api/src/services/document-purge.service.ts';
import { RetentionPolicyService } from '../apps/api/src/services/retention-policy.service.ts';
import { StorageService } from '../apps/api/src/services/storage.service.ts';
import { createPrismaOrganisationStorageResolver } from '../apps/api/src/services/document-storage-resolution.ts';
import { createErasureDispatcher } from '../apps/api/src/services/document-erasure.ts';

const instanceId = process.argv[2];
assert.match(instanceId ?? '', /^[0-9a-f-]{36}$/);
assert.equal(instanceId, process.env.E2E_DATABASE_INSTANCE_ID);
assert.equal(process.env.E2E_DATABASE_IDENTITY_PROBE_ENABLED, 'true');
assert.equal(process.env.DOCUMENT_STORAGE_DRIVER, 'local');
const root = '/var/lib/charitypilot-e2e-documents';
assert.equal(process.env.LOCAL_FILE_STORAGE_DIR, root);
assert.ok((await readFile('/proc/self/mountinfo', 'utf8')).split('\n').some(line =>
  line.split(' ')[4] === root && line.includes(' - tmpfs ')), 'file store is not the attested tmpfs');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, 'db');
assert.equal(url.pathname, '/charitypilot_e2e_disposable');
assert.equal(url.username, 'charitypilot_e2e_runner');
url.searchParams.set('application_name', safety.DATABASE_SAFETY_CONTRACT.applicationName);
const prisma = new PrismaClient({ datasourceUrl: url.toString() });
const otherPrisma = new PrismaClient({ datasourceUrl: url.toString() });
try {
  for (const client of [prisma, otherPrisma]) {
    // Trusted, fixed repository query; never constructed from runtime input.
    const [identity] = await client.$queryRaw(Prisma.raw(safety.DATABASE_IDENTITY_SQL));
    safety.assertDatabaseIdentity(identity, { isRemote: false, expectedServerPort: 5432, instanceId });
  }
  assert.equal(await prisma.documentStorageDeletion.count(), 0, 'worker proof requires an empty job queue');
  const organisationId = `purge-proof-${randomUUID()}`;
  const actorUserId = `owner-${randomUUID()}`;
  await prisma.$transaction(async tx => {
    await tx.organisation.create({ data: { id: organisationId, name: 'Synthetic purge worker proof', documentStorageProvider: 'local', documentStorageAlphaOptIn: true } });
    await tx.user.create({ data: { id: actorUserId, organisationId, role: 'OWNER', email: `${actorUserId}@example.invalid`, name: 'Synthetic proof owner', passwordHash: 'synthetic-non-login-fixture' } });
  });
  const policy = await new RetentionPolicyService(prisma).create(organisationId, actorUserId, {
    state: 'APPROVED', retentionMode: 'REVIEW_REQUIRED', retentionDays: null, recoveryDays: 30,
    authorityConfirmed: true, approvalEvidenceRef: 'SYNTHETIC-WORKER-POLICY',
  });
  const storage = new StorageService(createPrismaOrganisationStorageResolver(prisma));
  const read = (org, path, provider) => storage.downloadFile(org, path, provider);
  const recovery = new DocumentRecoveryService(prisma, read);
  const purge = new DocumentPurgeService(prisma, read);
  const bytes = Buffer.from('Synthetic retained file for real primary-storage purge proof.');
  const untouched = await storage.uploadFile(organisationId, 'untouched.txt', bytes, 'text/plain');
  const prepare = async () => {
    const file = await storage.uploadFile(organisationId, 'purge.txt', bytes, 'text/plain');
    const doc = await prisma.document.create({ data: { organisationId, name: 'Synthetic purge proof', category: 'OTHER',
      lifecycleStatus: 'DRAFT', storageProvider: file.provider, fileUrl: file.storagePath, fileSize: bytes.length, mimeType: 'text/plain' } });
    await recovery.remove({ organisationId, actorUserId, documentId: doc.id, expectedUpdatedAt: doc.updatedAt,
      policyId: policy.id, evidenceRef: 'SYNTHETIC-REMOVE', reason: 'Remove synthetic bytes for guarded worker proof.' });
    assert.deepEqual(await read(organisationId, file.storagePath, 'local'), bytes);
    // Only this identity-verified disposable fixture advances removal dates.
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard"`;
      await tx.$executeRaw`UPDATE "Document" SET "deletedAt"="deletedAt"-INTERVAL '31 days',"recoveryUntil"="recoveryUntil"-INTERVAL '31 days' WHERE id=${doc.id} AND "organisationId"=${organisationId}`;
      await tx.$executeRaw`ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"`;
    });
    const current = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    const dispositionPlan = Object.fromEntries(['PRIMARY','VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS'].map(area =>
      [area, { disposition: area === 'PRIMARY' ? 'DISPOSE' : 'RETAIN_APPROVED', evidenceRef: `SYNTHETIC-${area}` }]));
    const auth = await purge.authorize(organisationId, actorUserId, { documentId: doc.id, expectedUpdatedAt: current.updatedAt.toISOString(),
      policyId: policy.id, authorityConfirmed: true, dispositionPlan, evidenceRef: 'SYNTHETIC-PURGE', reason: 'Approve synthetic primary disposal for worker proof.' });
    const claim = await purge.claim(organisationId, actorUserId, auth.id, { confirmPermanentPurge: true });
    assert.deepEqual(await read(organisationId, file.storagePath, 'local'), bytes, 'claim itself must not delete bytes');
    return { file, claim };
  };
  const target = await prepare();
  let release;
  let started;
  const barrier = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let dispatches = 0;
  const erase = async ({ organisationId: org, storagePath }, signal) => {
    dispatches++; return storage.deleteFile(org, storagePath, signal, 'local');
  };
  const first = new DocumentService(prisma).retryPendingStorageDeletions(createErasureDispatcher({ local: async (value, signal) => {
    started(); await released; return erase(value, signal);
  } }), 1);
  try {
    await Promise.race([barrier, first.then(() => { throw new Error('first worker did not reach dispatch'); })]);
    const competing = await new DocumentService(otherPrisma).retryPendingStorageDeletions(createErasureDispatcher({ local: erase }), 1);
    assert.equal(competing.processed, 0);
  } finally { release(); }
  assert.equal((await first).processed, 1);
  assert.equal(dispatches, 1, 'only the claiming worker may dispatch');
  await assert.rejects(readFile(`${root}/${target.file.storagePath}`), { code: 'ENOENT' });
  const done = await prisma.documentStorageDeletion.findUniqueOrThrow({ where: { id: target.claim.deletionId } });
  // The outbox attempts field counts recorded failures, not successful dispatches.
  assert.equal(done.state, 'PROCESSED'); assert.ok(done.activeObjectAbsentAt); assert.equal(done.attempts, 0);
  const repeated = await new DocumentService(prisma).retryPendingStorageDeletions(createErasureDispatcher({ local: erase }), 1);
  assert.equal(repeated.processed, 0); assert.equal(dispatches, 1);
  assert.deepEqual(await read(organisationId, untouched.storagePath, 'local'), bytes);

  const timeoutTarget = await prepare();
  const timeoutWorker = new DocumentService(prisma, () => new Date(), 40);
  const timed = await timeoutWorker.retryPendingStorageDeletions(createErasureDispatcher({ local: async () => new Promise(() => {}) }), 1);
  assert.equal(timed.retryScheduled, 1);
  const pending = await prisma.documentStorageDeletion.findUniqueOrThrow({ where: { id: timeoutTarget.claim.deletionId } });
  assert.equal(pending.state, 'PENDING'); assert.equal(pending.activeObjectAbsentAt, null); assert.ok(pending.nextAttemptAt);
  assert.deepEqual(await read(organisationId, timeoutTarget.file.storagePath, 'local'), bytes);
  const retryWorker = new DocumentService(prisma);
  assert.equal((await retryWorker.retryPendingStorageDeletions(createErasureDispatcher({ local: erase }), 1)).processed, 0,
    'the database must refuse an early retry');
  console.log('Timeout preserved bytes; waiting for the real database retry deadline (about five minutes).');
  const waitStarted = performance.now();
  while (true) {
    const [deadline] = await prisma.$queryRaw`SELECT "nextAttemptAt" <= CURRENT_TIMESTAMP AS due FROM "DocumentStorageDeletion" WHERE id=${timeoutTarget.claim.deletionId}`;
    assert.ok(deadline, 'retry receipt disappeared');
    if (deadline.due) break;
    assert.ok(performance.now() - waitStarted < 360_000, 'retry deadline did not arrive within the bounded wait');
    await delay(1000);
  }
  assert.equal((await retryWorker.retryPendingStorageDeletions(createErasureDispatcher({ local: erase }), 1)).processed, 1);
  await assert.rejects(readFile(`${root}/${timeoutTarget.file.storagePath}`), { code: 'ENOENT' });
  const retried = await prisma.documentStorageDeletion.findUniqueOrThrow({ where: { id: timeoutTarget.claim.deletionId } });
  assert.equal(retried.attempts, 1); assert.ok(retried.activeObjectAbsentAt);
  assert.deepEqual(await read(organisationId, untouched.storagePath, 'local'), bytes);
  console.log('Purge worker proof passed: exact local bytes removed; concurrent dispatch excluded; timeout retained bytes; retry verified absence. Other stores remain unverified.');
} finally {
  await Promise.allSettled([prisma.$disconnect(), otherPrisma.$disconnect()]);
}
