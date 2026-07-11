import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';
import { getLocalAdminSeedConfig, type LocalAdminSeedConfig } from '../src/services/local-admin-seed.js';
import { serializeErrorForLog } from '../src/utils/logger.js';
import { DeadlineService } from '../src/services/deadline.service.js';

const prisma = new PrismaClient();
const DEFAULT_LOCAL_STORAGE_DIR = '.charitypilot-local-storage/documents';

type EnabledLocalAdminSeedConfig = LocalAdminSeedConfig & { enabled: true };

async function seedGovernanceCode() {
  let principleCount = 0;
  let standardCount = 0;
  let globalSortOrder = 1;

  for (const principle of GOVERNANCE_PRINCIPLES) {
    const created = await prisma.governancePrinciple.upsert({
      where: { number: principle.number },
      update: {
        title: principle.title,
        description: principle.description,
        sortOrder: principle.number,
      },
      create: {
        number: principle.number,
        title: principle.title,
        description: principle.description,
        sortOrder: principle.number,
      },
    });
    principleCount++;

    for (const standard of principle.standards) {
      await prisma.governanceStandard.upsert({
        where: { code: standard.code },
        update: {
          principleId: created.id,
          title: standard.title,
          isCore: standard.isCore,
          isAdditional: standard.isAdditional,
          sortOrder: globalSortOrder,
        },
        create: {
          principleId: created.id,
          code: standard.code,
          title: standard.title,
          isCore: standard.isCore,
          isAdditional: standard.isAdditional,
          sortOrder: globalSortOrder,
        },
      });
      globalSortOrder++;
      standardCount++;
    }
  }

  return { principleCount, standardCount };
}

function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function slugifyDocumentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function seededDocumentStoragePath(organisationId: string, name: string): string {
  return `${organisationId}/seeded-documents/${slugifyDocumentName(name)}.pdf`;
}

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, (match) => `\\${match}`);
}

function seededDocumentPdf(documentName: string): Buffer {
  const content = `BT /F1 12 Tf 36 96 Td (CharityPilot local seed document: ${escapePdfText(documentName)}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const offsets: number[] = [];
  let output = '%PDF-1.4\n';

  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, 'utf8'));
    output += object;
  }

  const xrefOffset = Buffer.byteLength(output, 'utf8');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(output, 'utf8');
}

function localStorageRoot(): string {
  return resolve(process.env.LOCAL_FILE_STORAGE_DIR ?? DEFAULT_LOCAL_STORAGE_DIR);
}

function isLocalStorageDriver(): boolean {
  return process.env.DOCUMENT_STORAGE_DRIVER === 'local';
}

function localSeedFilePath(storagePath: string): string {
  const root = localStorageRoot();
  const filePath = resolve(root, storagePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    throw new Error(`Seed document path escapes local storage: ${storagePath}`);
  }

  return filePath;
}

async function writeLocalSeedDocument(storagePath: string, documentName: string): Promise<void> {
  if (!isLocalStorageDriver()) return;

  const filePath = localSeedFilePath(storagePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, seededDocumentPdf(documentName));
}

async function upsertBoardMember(organisationId: string, data: {
  name: string;
  role: string;
  email: string;
  appointedDate: Date;
  termEndDate?: Date;
  conductSigned: boolean;
  conductSignedDate?: Date;
  inductionCompleted: boolean;
  inductionDate?: Date;
}) {
  const existing = await prisma.boardMember.findFirst({
    where: { organisationId, email: data.email },
  });

  if (existing) {
    return prisma.boardMember.update({ where: { id: existing.id }, data });
  }

  return prisma.boardMember.create({ data: { organisationId, ...data } });
}

async function upsertDocument(organisationId: string, uploadedById: string, data: {
  name: string;
  description: string;
  category: 'CONSTITUTION' | 'POLICY' | 'BOARD_MINUTES' | 'FINANCIAL_STATEMENT' | 'INSURANCE' | 'ANNUAL_REPORT' | 'RISK_REGISTER' | 'CODE_OF_CONDUCT' | 'STRATEGIC_PLAN' | 'OTHER';
  owner: string;
  approvedDate?: Date;
  nextReviewDate?: Date;
  boardMinuteReference?: string;
}) {
  const existing = await prisma.document.findFirst({
    where: { organisationId, name: data.name },
  });
  const fileUrl = seededDocumentStoragePath(organisationId, data.name);
  await writeLocalSeedDocument(fileUrl, data.name);

  const payload = {
    ...data,
    fileUrl,
    fileSize: seededDocumentPdf(data.name).byteLength,
    mimeType: 'application/pdf',
    uploadedById,
  };

  if (existing) {
    return prisma.document.update({ where: { id: existing.id }, data: payload });
  }

  return prisma.document.create({ data: { organisationId, ...payload } });
}

async function upsertDeadline(organisationId: string, data: {
  title: string;
  description: string;
  dueDate: Date;
  isAutoGenerated?: boolean;
  reminderDays?: number[];
}) {
  const existing = await prisma.deadline.findFirst({
    where: { organisationId, title: data.title, isAutoGenerated: false, archivedAt: null },
  });

  if (existing) {
    return prisma.deadline.update({ where: { id: existing.id }, data });
  }

  return prisma.deadline.create({ data: { organisationId, ...data } });
}

async function seedDemoWorkspace(config: EnabledLocalAdminSeedConfig) {
  const financialYearEnd = dateFromIso('2025-12-31');
  const currentPeriodStart = new Date();
  const currentPeriodEnd = dateFromIso('2099-12-31');
  const passwordHash = await bcrypt.hash(config.password, 12);
  const organisationData = {
    rcnNumber: '20000000',
    croNumber: '700000',
    legalForm: 'CLG' as const,
    legalFormConfirmedAt: new Date('2026-07-10T00:00:00.000Z'),
    complexity: 'COMPLEX' as const,
    charitablePurpose: ['COMMUNITY_BENEFIT', 'EDUCATION'] as const,
    financialYearEnd,
    registeredAddress: '1 Governance Square, Dublin 2',
    contactEmail: 'governance@example.org',
    contactPhone: '+353 1 555 0100',
    website: 'https://example.org',
    dateRegistered: dateFromIso('2018-05-15'),
    incorporationDate: dateFromIso('2018-02-01'),
    croAnnualReturnDate: dateFromIso('2026-09-30'),
    croAnnualReturnDateConfirmedAt: new Date('2026-07-10T00:00:00.000Z'),
    lastActualAgmDate: dateFromIso('2026-03-12'),
    memberCount: 3,
  };

  // The database defers its exactly-one-owner check until commit. Keep a new
  // organisation, its accountable owner, and its entitlement in one atomic
  // transaction so a seed can never commit an ownerless workspace.
  const { organisation, user } = await prisma.$transaction(async (tx) => {
    const existingOrganisation = await tx.organisation.findFirst({
      where: { name: config.organisationName },
    });
    const seededOrganisation = existingOrganisation
      ? await tx.organisation.update({
          where: { id: existingOrganisation.id },
          data: organisationData,
        })
      : await tx.organisation.create({
          data: {
            name: config.organisationName,
            ...organisationData,
          },
        });

    const seededUser = await tx.user.upsert({
      where: { email: config.email },
      update: {
        name: config.name,
        passwordHash,
        role: 'OWNER',
        organisationId: seededOrganisation.id,
        emailVerified: true,
      },
      create: {
        email: config.email,
        name: config.name,
        passwordHash,
        role: 'OWNER',
        organisationId: seededOrganisation.id,
        emailVerified: true,
      },
    });

    await tx.subscription.upsert({
      where: { organisationId: seededOrganisation.id },
      update: {
        plan: config.subscriptionPlan,
        status: config.subscriptionStatus,
        trialEndsAt: null,
        currentPeriodStart,
        currentPeriodEnd,
      },
      create: {
        organisationId: seededOrganisation.id,
        plan: config.subscriptionPlan,
        status: config.subscriptionStatus,
        trialEndsAt: null,
        currentPeriodStart,
        currentPeriodEnd,
      },
    });

    return { organisation: seededOrganisation, user: seededUser };
  });

  await upsertBoardMember(organisation.id, {
    name: 'Aoife Murphy',
    role: 'Chair',
    email: 'aoife@example.org',
    appointedDate: dateFromIso('2022-04-20'),
    termEndDate: dateFromIso('2028-04-20'),
    conductSigned: true,
    conductSignedDate: dateFromIso('2026-01-10'),
    inductionCompleted: true,
    inductionDate: dateFromIso('2022-04-22'),
  });

  const treasurer = await upsertBoardMember(organisation.id, {
    name: 'Brian Walsh',
    role: 'Treasurer',
    email: 'brian@example.org',
    appointedDate: dateFromIso('2020-09-01'),
    termEndDate: dateFromIso('2026-09-01'),
    conductSigned: true,
    conductSignedDate: dateFromIso('2026-01-10'),
    inductionCompleted: true,
    inductionDate: dateFromIso('2020-09-04'),
  });

  await upsertBoardMember(organisation.id, {
    name: 'Ciara Byrne',
    role: 'Trustee',
    email: 'ciara@example.org',
    appointedDate: dateFromIso('2025-11-05'),
    conductSigned: false,
    inductionCompleted: false,
  });

  await upsertDocument(organisation.id, user.id, {
    name: 'Governing Document',
    description: 'Current constitution and governing document approved by the board.',
    category: 'CONSTITUTION',
    owner: 'Company Secretary',
    approvedDate: dateFromIso('2024-10-08'),
    nextReviewDate: dateFromIso('2027-10-08'),
    boardMinuteReference: 'BM-2024-10-08-04',
  });

  await upsertDocument(organisation.id, user.id, {
    name: 'Trustee Code of Conduct',
    description: 'Signed trustee code of conduct template and board approval record.',
    category: 'CODE_OF_CONDUCT',
    owner: 'Chair',
    approvedDate: dateFromIso('2026-01-10'),
    nextReviewDate: dateFromIso('2027-01-10'),
    boardMinuteReference: 'BM-2026-01-10-02',
  });

  await upsertDocument(organisation.id, user.id, {
    name: 'Financial Controls Policy',
    description: 'Controls for banking, expenditure approval, reserves, restricted funds, and management accounts.',
    category: 'POLICY',
    owner: 'Treasurer',
    approvedDate: dateFromIso('2026-02-14'),
    nextReviewDate: dateFromIso('2027-02-14'),
    boardMinuteReference: 'BM-2026-02-14-05',
  });

  await upsertDocument(organisation.id, user.id, {
    name: 'Insurance Schedule',
    description: 'Public liability, employer liability, trustee indemnity, and property insurance evidence.',
    category: 'INSURANCE',
    owner: 'Operations Manager',
    approvedDate: dateFromIso('2026-01-31'),
    nextReviewDate: dateFromIso('2027-01-31'),
  });

  await prisma.$transaction(async (tx) => {
    await new DeadlineService(tx).reconcileGeneratedDeadlines(organisation.id);
  });

  await upsertDeadline(organisation.id, {
    title: 'Board approval of Compliance Record Form',
    description: 'Board to review the annual compliance position, evidence gaps, explanations, and sign-off.',
    dueDate: dateFromIso('2026-09-15'),
    reminderDays: [30, 14, 7],
  });

  await upsertDeadline(organisation.id, {
    title: 'Review risk register',
    description: 'Quarterly trustee review of strategic, financial, operational, and safeguarding risks.',
    dueDate: dateFromIso('2026-06-30'),
    reminderDays: [14, 7],
  });

  const standards = await prisma.governanceStandard.findMany({ orderBy: { sortOrder: 'asc' } });
  const reportingYear = 2026;

  for (const [index, standard] of standards.entries()) {
    const status: 'WORKING_TOWARDS' | 'EXPLAIN' | 'COMPLIANT' =
      index % 9 === 0 ? 'WORKING_TOWARDS' : index % 13 === 0 ? 'EXPLAIN' : 'COMPLIANT';
    await prisma.complianceRecord.upsert({
      where: {
        organisationId_standardId_reportingYear: {
          organisationId: organisation.id,
          standardId: standard.id,
          reportingYear,
        },
      },
      update: {
        status,
        actionTaken: `Demo action recorded for standard ${standard.code}.`,
        evidence: `Evidence linked in the demo evidence vault for ${standard.code}.`,
        notes: status === 'EXPLAIN' ? 'Board explanation required before annual sign-off.' : null,
        explanationIfNA: null,
        updatedById: user.id,
      },
      create: {
        organisationId: organisation.id,
        standardId: standard.id,
        reportingYear,
        status,
        actionTaken: `Demo action recorded for standard ${standard.code}.`,
        evidence: `Evidence linked in the demo evidence vault for ${standard.code}.`,
        notes: status === 'EXPLAIN' ? 'Board explanation required before annual sign-off.' : null,
        updatedById: user.id,
      },
    });
  }

  await prisma.complianceSignoff.upsert({
    where: { organisationId_reportingYear: { organisationId: organisation.id, reportingYear } },
    update: {
      status: 'BOARD_REVIEW',
      boardMeetingDate: dateFromIso('2026-09-15'),
      minuteReference: 'BM-2026-09-15-03',
      approvedByName: 'Aoife Murphy',
      approvedByRole: 'Chair',
      approvalNotes: 'Draft sign-off prepared for September board review.',
      updatedById: user.id,
    },
    create: {
      organisationId: organisation.id,
      reportingYear,
      status: 'BOARD_REVIEW',
      boardMeetingDate: dateFromIso('2026-09-15'),
      minuteReference: 'BM-2026-09-15-03',
      approvedByName: 'Aoife Murphy',
      approvedByRole: 'Chair',
      approvalNotes: 'Draft sign-off prepared for September board review.',
      updatedById: user.id,
    },
  });

  const existingConflict = await prisma.conflictRecord.findFirst({
    where: { organisationId: organisation.id, matter: 'Treasurer connected supplier quote' },
  });
  const conflictData = {
    organisationId: organisation.id,
    boardMemberId: treasurer.id,
    trusteeName: 'Brian Walsh',
    matter: 'Treasurer connected supplier quote',
    nature: 'Treasurer declared a family connection to one supplier considered for IT support.',
    dateDeclared: dateFromIso('2026-02-14'),
    meetingDate: dateFromIso('2026-02-14'),
    actionTaken: 'Treasurer withdrew from discussion and decision. Alternative quotations were minuted.',
    decision: 'Board selected another supplier after reviewing three quotes.',
    status: 'MANAGED' as const,
    minuteReference: 'BM-2026-02-14-06',
    nextReviewDate: dateFromIso('2026-08-14'),
  };
  if (existingConflict) {
    await prisma.conflictRecord.update({ where: { id: existingConflict.id }, data: conflictData });
  } else {
    await prisma.conflictRecord.create({ data: conflictData });
  }

  const existingRisk = await prisma.riskRecord.findFirst({
    where: { organisationId: organisation.id, title: 'Annual Report filing delay' },
  });
  const riskData = {
    organisationId: organisation.id,
    title: 'Annual Report filing delay',
    category: 'GOVERNANCE' as const,
    description: 'Late preparation of financial statements could delay Annual Report filing.',
    likelihood: 3,
    impact: 4,
    mitigation: 'Finance timetable approved, audit dates booked, and board approval deadline created.',
    owner: 'Treasurer',
    reviewDate: dateFromIso('2026-06-30'),
    status: 'MONITORING' as const,
    boardMinuteReference: 'BM-2026-03-12-04',
  };
  if (existingRisk) {
    await prisma.riskRecord.update({ where: { id: existingRisk.id }, data: riskData });
  } else {
    await prisma.riskRecord.create({ data: riskData });
  }

  const existingComplaint = await prisma.complaintRecord.findFirst({
    where: { organisationId: organisation.id, summary: 'Delayed response to volunteer query' },
  });
  const complaintData = {
    organisationId: organisation.id,
    receivedDate: dateFromIso('2026-03-05'),
    source: 'Volunteer',
    summary: 'Delayed response to volunteer query',
    actionTaken: 'Volunteer coordinator contacted the volunteer and reviewed response-time procedures.',
    outcome: 'Procedure updated and complaint closed.',
    status: 'CLOSED' as const,
    reviewedByBoard: true,
    boardMinuteReference: 'BM-2026-03-12-07',
  };
  if (existingComplaint) {
    await prisma.complaintRecord.update({ where: { id: existingComplaint.id }, data: complaintData });
  } else {
    await prisma.complaintRecord.create({ data: complaintData });
  }

  const existingFundraising = await prisma.fundraisingRecord.findFirst({
    where: { organisationId: organisation.id, name: 'Community Summer Appeal' },
  });
  const fundraisingData = {
    organisationId: organisation.id,
    name: 'Community Summer Appeal',
    activityType: 'Public donation campaign',
    startDate: dateFromIso('2026-06-01'),
    endDate: dateFromIso('2026-08-31'),
    publicFacing: true,
    thirdPartyFundraiser: null,
    controls: 'Donation pages include charity name and RCN. Cash handling requires dual count and bank lodgement record.',
    complaintsReceived: false,
    reviewOutcome: 'Campaign controls approved by board before launch.',
    status: 'OPEN' as const,
    boardMinuteReference: 'BM-2026-05-20-05',
  };
  if (existingFundraising) {
    await prisma.fundraisingRecord.update({ where: { id: existingFundraising.id }, data: fundraisingData });
  } else {
    await prisma.fundraisingRecord.create({ data: fundraisingData });
  }

  await prisma.annualReportReadiness.upsert({
    where: { organisationId_reportingYear: { organisationId: organisation.id, reportingYear } },
    update: {
      activitiesNarrative: 'Demo narrative covering community education programmes, volunteer supports, and public benefit.',
      publicBenefitStatement: 'The charity advances education and community benefit by providing accessible governance and volunteer support programmes.',
      beneficiariesSummary: 'Direct beneficiaries include volunteer-led community groups and trustees of small charities.',
      financialStatementsApproved: false,
      annualReportUploaded: false,
      trusteeDetailsReviewed: true,
      fundraisingReviewed: true,
      complaintsReviewed: true,
      boardApprovalDate: null,
      filingStatus: 'IN_PROGRESS',
      filedDate: null,
      notes: 'Financial statements approval and final board approval remain outstanding.',
    },
    create: {
      organisationId: organisation.id,
      reportingYear,
      activitiesNarrative: 'Demo narrative covering community education programmes, volunteer supports, and public benefit.',
      publicBenefitStatement: 'The charity advances education and community benefit by providing accessible governance and volunteer support programmes.',
      beneficiariesSummary: 'Direct beneficiaries include volunteer-led community groups and trustees of small charities.',
      financialStatementsApproved: false,
      annualReportUploaded: false,
      trusteeDetailsReviewed: true,
      fundraisingReviewed: true,
      complaintsReviewed: true,
      filingStatus: 'IN_PROGRESS',
      notes: 'Financial statements approval and final board approval remain outstanding.',
    },
  });

  await prisma.financialControlReview.upsert({
    where: { organisationId_reportingYear: { organisationId: organisation.id, reportingYear } },
    update: {
      bankReconciliationsReviewed: true,
      dualAuthorisation: true,
      budgetApproved: true,
      managementAccountsReviewed: true,
      reservesReviewed: false,
      restrictedFundsReviewed: true,
      assetsInsuranceReviewed: true,
      payrollControlsReviewed: false,
      fundraisingControlsReviewed: true,
      reviewedBy: 'Brian Walsh',
      reviewDate: dateFromIso('2026-02-14'),
      minuteReference: 'BM-2026-02-14-05',
      actions: 'Reserves policy refresh and payroll controls review to be completed before annual sign-off.',
    },
    create: {
      organisationId: organisation.id,
      reportingYear,
      bankReconciliationsReviewed: true,
      dualAuthorisation: true,
      budgetApproved: true,
      managementAccountsReviewed: true,
      reservesReviewed: false,
      restrictedFundsReviewed: true,
      assetsInsuranceReviewed: true,
      payrollControlsReviewed: false,
      fundraisingControlsReviewed: true,
      reviewedBy: 'Brian Walsh',
      reviewDate: dateFromIso('2026-02-14'),
      minuteReference: 'BM-2026-02-14-05',
      actions: 'Reserves policy refresh and payroll controls review to be completed before annual sign-off.',
    },
  });

  return { email: config.email, organisationName: organisation.name };
}

async function main() {
  const governance = await seedGovernanceCode();

  console.log(`Seeded ${governance.principleCount} governance principles and ${governance.standardCount} governance standards.`);

  const localAdminSeed = getLocalAdminSeedConfig();
  if (localAdminSeed.enabled) {
    const demo = await seedDemoWorkspace(localAdminSeed);
    console.log(`Local admin workspace ready: ${demo.organisationName} (${demo.email}).`);
    console.log('Use the configured local admin password only outside production.');
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Prisma seed failed:', serializeErrorForLog(e));
    await prisma.$disconnect();
    process.exit(1);
  });
