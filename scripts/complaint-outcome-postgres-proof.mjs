import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { readCommittedComplaintOutcome } from '../apps/api/src/services/complaint-recovery-outcome.ts';

// Called only by the disposable migration fixture; connection input is never logged.
const prisma = new PrismaClient({ datasources: { db: { url: readFileSync(0, 'utf8').trim() } } });
try {
  const preparation = await prisma.complaintRecoveryPreparation.findUniqueOrThrow({ where: { id: 'prepared-fresh-purge' } });
  const request = { organisationId: preparation.organisationId, installationId: preparation.installationId,
    operationId: preparation.operationId };
  const first = await readCommittedComplaintOutcome(prisma, request);
  assert.equal(first.actionAuthorized, false);
  assert.equal(JSON.parse(first.body).preparationDigest, preparation.factsDigest);
  assert.equal(first.body.includes('reason'), false);
  await prisma.$disconnect();
  assert.deepEqual(await readCommittedComplaintOutcome(prisma, request), first);
  await assert.rejects(() => readCommittedComplaintOutcome(prisma, { ...request, organisationId: 'b' }), /unavailable/);
  process.stdout.write('committed-outcome-reader-verified');
} finally { await prisma.$disconnect(); }
