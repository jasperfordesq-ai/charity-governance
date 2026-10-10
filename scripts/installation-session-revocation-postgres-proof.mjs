import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { revokeInstallationSessions } from '../apps/api/dist/services/installation-session-revocation.js';

// Only the disposable, loopback-published PostgreSQL fixture created by the
// parent test may invoke this process. Never run against a charity database.
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(process.env.CHARITYPILOT_SYNTHETIC_SESSION_PROOF, '1');
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/charitypilot_session_revocation_[a-f0-9]{32}$/u);
const prisma = new PrismaClient();
const reason = 'Synthetic exposure drill only';
const expiresAt = new Date(Date.now() + 86_400_000);
try {
  const org = await prisma.organisation.create({ data: { name: 'Synthetic Charity',
    users: { create: { email: 'synthetic@example.org', name: 'Synthetic Trustee', passwordHash: 'x', role: 'OWNER' } } } });
  const user = await prisma.user.findFirstOrThrow({ where: { organisationId: org.id } });

  // A refresh revokes its old row and inserts the replacement, and is still
  // open when the revocation starts. The revocation must wait, then revoke it.
  const family = randomUUID();
  const login = await prisma.authSession.create({ data: { userId: user.id,
    refreshTokenHash: 'c'.repeat(64), familyId: family, expiresAt } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalInserted;
  const inserted = new Promise((resolve) => { signalInserted = resolve; });
  const refresh = prisma.$transaction(async (tx) => {
    await tx.authSession.update({ where: { id: login.id },
      data: { revokedAt: new Date(), revocationReason: 'ROTATED' } });
    await tx.authSession.create({ data: { userId: user.id, refreshTokenHash: 'd'.repeat(64),
      familyId: family, familyCreatedAt: login.familyCreatedAt, expiresAt } });
    signalInserted();
    await gate;
  }, { timeout: 30_000 });
  await inserted;
  let finished = false;
  const revocation = revokeInstallationSessions(prisma, { realm: 'all', reason, confirm: true })
    .then((result) => { finished = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(finished, false, 'the revocation waits for the refresh in flight');
  release();
  await refresh;
  const raced = await revocation;
  assert.deepEqual([raced.userSessions, raced.members, raced.charities], [1, 1, 1]);
  const rows = await prisma.authSession.findMany({ where: { familyId: family }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((row) => row.revocationReason), ['ROTATED', 'INSTALLATION_SESSIONS_REVOKED']);
  const events = await prisma.securityAuditEvent.findMany({ where: { organisationId: org.id } });
  assert.deepEqual(events.map((e) => [e.type, e.actorKind, e.subjectUserId, e.subjectLabel, e.reason]),
    [['ALL_SESSIONS_REVOKED', 'SYSTEM', user.id, 'Synthetic Trustee', reason]]);

  // The old family can never create another session; a new sign-in can.
  await assert.rejects(prisma.authSession.create({ data: { userId: user.id, refreshTokenHash: 'e'.repeat(64),
    familyId: family, familyCreatedAt: login.familyCreatedAt, expiresAt } }),
  /predates an installation-wide revocation/);
  await prisma.authSession.create({ data: { userId: user.id, refreshTokenHash: 'f'.repeat(64), expiresAt } });

  // Deadlock: a refresh locks its row and pauses; the job takes the cutoff and
  // waits on that row; the refresh then needs the cutoff. PostgreSQL aborts
  // one side. Either way the job completes and no live session survives.
  const family2 = randomUUID();
  const login2 = await prisma.authSession.create({ data: { userId: user.id,
    refreshTokenHash: '7'.repeat(64), familyId: family2, expiresAt } });
  let releaseRefresh;
  const resume = new Promise((resolve) => { releaseRefresh = resolve; });
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  const refresh2 = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AuthSession" WHERE id = ${login2.id} FOR UPDATE`;
    signalLocked();
    await resume;
    await tx.authSession.update({ where: { id: login2.id },
      data: { revokedAt: new Date(), revocationReason: 'ROTATED' } });
    await tx.authSession.create({ data: { userId: user.id, refreshTokenHash: '8'.repeat(64),
      familyId: family2, familyCreatedAt: login2.familyCreatedAt, expiresAt } });
  }, { timeout: 30_000 }).then(() => ({ committed: true, error: null }), (error) => ({ committed: false, error }));
  await locked;
  // Count the job's transaction attempts, so a retry is observed, not assumed.
  let jobAttempts = 0;
  const counted = { $transaction: (...args) => { jobAttempts += 1; return prisma.$transaction(...args); } };
  const deadlocked = revokeInstallationSessions(counted, { realm: 'user', reason, confirm: true });
  // Release the refresh only once the job is blocked on the refresh's row,
  // which it reaches after taking the cutoff: the cycle is then certain.
  let blocked = false;
  for (let i = 0; i < 100 && !blocked; i += 1) {
    const waiting = await prisma.$queryRaw`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"AuthSession"%'`;
    blocked = waiting[0].count > 0;
    if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(blocked, 'the job must be waiting on the refresh before the refresh continues');
  releaseRefresh();
  const [refreshOutcome, deadlockRun] = await Promise.all([refresh2, deadlocked]);
  assert.equal(deadlockRun.confirmed, true);
  // PostgreSQL aborts one side. Either the refresh failed with a deadlock and
  // the job finished first time, or the job was aborted and retried.
  if (refreshOutcome.committed) {
    assert.ok(jobAttempts >= 2, `the aborted job must have been retried (attempts ${jobAttempts})`);
  } else {
    assert.match(String(refreshOutcome.error?.message ?? refreshOutcome.error), /deadlock/i);
    assert.equal(jobAttempts, 1);
  }
  assert.equal(await prisma.authSession.count({ where: { familyId: family2, revokedAt: null } }), 0,
    'no live session after the deadlock');

  // Operators: the same for an operator family.
  const operator = await prisma.platformOperator.create({ data: { email: 'operator@example.org',
    name: 'Synthetic Operator', passwordHash: 'x' } });
  const operatorSession = await prisma.platformOperatorSession.create({ data: { operatorId: operator.id,
    tokenHash: '1'.repeat(64), expiresAt } });
  const operators = await revokeInstallationSessions(prisma, { realm: 'operator', reason, confirm: true });
  assert.equal(operators.operatorSessions, 1);
  await assert.rejects(prisma.platformOperatorSession.create({ data: { operatorId: operator.id,
    tokenHash: '2'.repeat(64), expiresAt, familyId: operatorSession.familyId,
    familyCreatedAt: operatorSession.familyCreatedAt } }), /predates an installation-wide revocation/);
  await prisma.platformOperatorSession.create({ data: { operatorId: operator.id, tokenHash: '3'.repeat(64), expiresAt } });

  // The cutoff only moves forward and cannot be removed or duplicated.
  await assert.rejects(prisma.$executeRaw`UPDATE "InstallationSessionCutoff"
    SET "userFamiliesBefore"='-infinity' WHERE id=1`, /only moves forward/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "InstallationSessionCutoff"`, /only moves forward/);
  await assert.rejects(prisma.$executeRaw`INSERT INTO "InstallationSessionCutoff"
    (id,"userFamiliesBefore","operatorFamiliesBefore","updatedAt") VALUES (1,now(),now(),now())`,
  /only moves forward/);
  process.stdout.write('installation-session-revocation-race=verified; old-family-insert=refused; '
    + 'new-sign-in=allowed; deadlock=resolved; operator-family=refused; cutoff=forward-only\n');
} finally {
  await prisma.$disconnect();
}
