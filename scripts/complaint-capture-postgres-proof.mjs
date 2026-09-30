import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { ComplaintRecoveryPreparationStore } from '../apps/api/src/services/complaint-recovery-preparation-store.ts';

// Called only by the isolated migration fixture. Never accept an ambient URL.
const url = readFileSync(0, 'utf8').trim();
assert.match(url, /^postgresql:\/\/postgres:synthetic-complaint-proof@127\.0\.0\.1:[0-9]+\/postgres$/);
const client = () => new PrismaClient({ datasources: { db: { url } } });
const writer = client(), capturer = client(), observer = client();
let release;
let holder;
try {
  const charity = await observer.organisation.findUnique({ where: { id: 'a' }, select: { name: true } });
  assert.equal(charity?.name, 'Synthetic A');
  const [version] = await observer.$queryRaw`SELECT current_setting('server_version_num')::integer AS version`;
  assert.ok(version.version >= 160000 && version.version < 170000);
  await writer.complaintRecord.create({ data: { id: 'capture-complaint', organisationId: 'a',
    receivedDate: new Date('2026-01-01Z'), summary: 'Synthetic subject content excluded from preparation', status: 'CLOSED' } });
  const removal = await writer.complaintRemoval.create({ data: { id: 'capture-removal', organisationId: 'a',
    complaintId: 'capture-complaint', recordRevision: 1, actorUserId: 'admin-a', policyId: 'final-review-policy',
    evidenceRef: 'CAPTURE-REMOVAL-1', reason: 'Synthetic reviewed removal for capture proof' } });
  await writer.complaintRecord.update({ where: { id: 'capture-complaint' },
    data: { removalId: removal.id, removedAt: removal.occurredAt } });
  const area = { disposition: 'RETAIN_APPROVED', evidenceRef: 'COPY-1' };
  await writer.complaintPurgeAuthorization.create({ data: { id: 'capture-review', organisationId: 'a',
    complaintId: 'capture-complaint', recordRevision: 2, holdRevision: 0, removalId: removal.id,
    policyId: 'final-review-policy', actorUserId: 'admin-a', recoveryUntil: removal.recoveryUntil,
    evidenceRef: 'CAPTURE-REVIEW-1', reason: 'Synthetic reviewed preparation only', dispositionPlan: {
      PRIMARY: { ...area, disposition: 'DISPOSE' }, SNAPSHOTS: area, EXPORTS: area, AUDIT: area, BACKUPS: area, OTHER_COPIES: area } } });
  const input = { installationId: 'synthetic-install', operationId: 'prisma-capture', writerEpoch: 1,
    authorizationId: 'capture-review', sourceRevision: 'a'.repeat(40) };
  const store = new ComplaintRecoveryPreparationStore(capturer);
  const first = await store.capture('a', 'admin-a', input);
  assert.equal(first.actionAuthorized, false);
  const saved = await observer.complaintRecoveryPreparation.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(JSON.parse(saved.facts).complaint.summary, undefined);
  await capturer.$disconnect();
  const retry = await store.capture('a', 'admin-a', input); // reconnect, no process cache
  assert.equal(retry.replayed, true); assert.equal(retry.id, first.id); assert.equal(retry.digest, first.digest);
  await assert.rejects(() => store.capture('a', 'admin-a', { ...input, writerEpoch: 2 }), /identity changed/);

  let ready;
  const locked = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  holder = writer.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id='a' FOR UPDATE`;
    await tx.complaintHoldEvent.create({ data: { id: 'capture-preservation', organisationId: 'a',
      complaintId: 'capture-complaint', revision: 1, recordRevision: 2, held: true, actorUserId: 'admin-a',
      evidenceRef: 'CAPTURE-HOLD-1', reason: 'Preserve during competing source capture' } });
    ready(); await gate;
  }, { timeout: 10000 });
  // Ensure an early holder failure cannot become an unhandled rejection.
  await Promise.race([locked, holder]);
  const attempt = store.capture('a', 'admin-a', { ...input, operationId: 'capture-during-hold' })
    .then(value => ({ value }), error => ({ error }));
  let blocked = false;
  for (let i = 0; i < 100; i++) {
    const [row] = await observer.$queryRaw`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Organisation%'`;
    if (row.count > 0) { blocked = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(blocked, true, 'capture must actually compete for the charity lock');
  release(); await holder;
  const result = await attempt;
  assert.ok(result.error, 'capture must not persist facts from before the committed hold');
  assert.equal(await observer.complaintRecoveryPreparation.count({ where: { operationId: 'capture-during-hold' } }), 0);
  await assert.rejects(() => store.capture('a', 'admin-a', { ...input, operationId: 'capture-after-hold' }));
  assert.equal(await observer.complaintPurgeClaim.count({ where: { complaintId: 'capture-complaint' } }), 0);
  assert.equal(await observer.complaintRecord.count({ where: { id: 'capture-complaint' } }), 1);
  process.stdout.write('capture-retry-and-preservation-race-verified');
} finally {
  release?.();
  await holder?.catch(() => {});
  await Promise.all([writer.$disconnect(), capturer.$disconnect(), observer.$disconnect()]);
}
