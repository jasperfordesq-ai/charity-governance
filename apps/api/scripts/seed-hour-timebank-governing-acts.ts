/**
 * Loads the nine governing acts from the hOUR Timebank CLG minute book
 * (RCN 20162023, CRO 608327) as an acceptance test for the Priority 1 build.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx apps/api/scripts/seed-hour-timebank-governing-acts.ts <organisationId>
 *
 * Rules:
 * - Do not fabricate any date, name, or approval.
 * - BM-2026-03-18 has status DRAFT — it was never approved.
 * - Minutes are approved by the immediately following meeting.
 *   Self-referential FK ordering: insert the approving act first.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const organisationId = process.argv[2];
  if (!organisationId) {
    console.error('Usage: tsx seed-hour-timebank-governing-acts.ts <organisationId>');
    process.exit(1);
  }

  const org = await prisma.organisation.findUnique({ where: { id: organisationId } });
  if (!org) {
    console.error(`Organisation ${organisationId} not found`);
    process.exit(1);
  }

  console.log(`Seeding governing acts for organisation: ${org.name} (${organisationId})`);

  // ── Insert acts in reverse chronological order so the approving act exists
  // before the act whose minutes it approves (self-referential FK constraint).

  // 1. Most recent board meeting — approves BM-2026-07-03 minutes
  const bm20260807 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-08-07' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-08-07'),
      reference: 'BM-2026-08-07',
      title: 'Board meeting — 7 August 2026',
    },
    update: {},
  });
  console.log(`Upserted ${bm20260807.reference}`);

  // 2. July meeting — approves BM-2026-06-12 minutes; its own minutes approved at BM-2026-08-07
  const bm20260703 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-07-03' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-07-03'),
      reference: 'BM-2026-07-03',
      title: 'Board meeting — 3 July 2026',
      approvedAtActId: bm20260807.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260703.reference}`);

  // 3. June meeting — its minutes approved at BM-2026-07-03
  const bm20260612 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-06-12' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-06-12'),
      reference: 'BM-2026-06-12',
      title: 'Board meeting — 12 June 2026',
      approvedAtActId: bm20260703.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260612.reference}`);

  // 4. May meeting — approved at BM-2026-06-12
  const bm20260508 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-05-08' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-05-08'),
      reference: 'BM-2026-05-08',
      title: 'Board meeting — 8 May 2026',
      approvedAtActId: bm20260612.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260508.reference}`);

  // 5. April meeting — approved at BM-2026-05-08
  const bm20260410 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-04-10' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-04-10'),
      reference: 'BM-2026-04-10',
      title: 'Board meeting — 10 April 2026',
      approvedAtActId: bm20260508.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260410.reference}`);

  // 6. March meeting — DRAFT; minutes were never presented for approval.
  //    Do NOT set approvedAtActId — that would imply approval exists.
  const bm20260318 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-03-18' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'DRAFT',
      actDate: new Date('2026-03-18'),
      reference: 'BM-2026-03-18',
      title: 'Board meeting — 18 March 2026',
      notes: 'Minutes remain in draft. Not presented at BM-2026-04-10.',
    },
    update: {},
  });
  console.log(`Upserted ${bm20260318.reference} (DRAFT — no approval)`);

  // 7. February meeting — approved at BM-2026-04-10
  //    (BM-2026-03-18 was not an ordinary approval meeting)
  const bm20260213 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-02-13' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-02-13'),
      reference: 'BM-2026-02-13',
      title: 'Board meeting — 13 February 2026',
      approvedAtActId: bm20260410.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260213.reference}`);

  // 8. AGM (annual general meeting) — sole-member written resolution discharging AGM
  //    obligation under s.175(4) Companies Act 2014
  const agm2025 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'MWR-2025-11-28' } },
    create: {
      organisationId,
      kind: 'MEMBER_WRITTEN_RESOLUTION',
      status: 'APPROVED',
      actDate: new Date('2025-11-28'),
      reference: 'MWR-2025-11-28',
      title: 'Unanimous annual written resolution of the sole member — 28 November 2025',
      statutoryBasis: 's.175(3) Companies Act 2014',
      notes: 'Discharged AGM obligations for FY2024–2025 under s.175(4).',
    },
    update: {},
  });
  console.log(`Upserted ${agm2025.reference}`);

  // 9. First board meeting of the year — approved at BM-2026-02-13
  const bm20260116 = await prisma.governingAct.upsert({
    where: { organisationId_reference: { organisationId, reference: 'BM-2026-01-16' } },
    create: {
      organisationId,
      kind: 'BOARD_MEETING',
      status: 'APPROVED',
      actDate: new Date('2026-01-16'),
      reference: 'BM-2026-01-16',
      title: 'Board meeting — 16 January 2026',
      approvedAtActId: bm20260213.id,
    },
    update: {},
  });
  console.log(`Upserted ${bm20260116.reference}`);

  console.log('\nDone. Summary:');
  const all = await prisma.governingAct.findMany({
    where: { organisationId },
    orderBy: { actDate: 'asc' },
    select: { reference: true, status: true, kind: true, actDate: true },
  });
  for (const act of all) {
    const date = act.actDate.toISOString().slice(0, 10);
    console.log(`  ${date}  ${act.reference.padEnd(18)}  ${act.status.padEnd(10)}  ${act.kind}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
