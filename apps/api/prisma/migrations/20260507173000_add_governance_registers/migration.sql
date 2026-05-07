-- CreateEnum
CREATE TYPE "RegisterStatus" AS ENUM ('OPEN', 'MONITORING', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('DECLARED', 'MANAGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('GOVERNANCE', 'FINANCIAL', 'OPERATIONAL', 'LEGAL', 'SAFEGUARDING', 'REPUTATIONAL', 'FUNDRAISING', 'DATA_PROTECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "AnnualReportFilingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BOARD_APPROVED', 'FILED');

-- AlterTable
ALTER TABLE "Document"
ADD COLUMN "owner" TEXT,
ADD COLUMN "approvedDate" TIMESTAMP(3),
ADD COLUMN "nextReviewDate" TIMESTAMP(3),
ADD COLUMN "boardMinuteReference" TEXT;

-- CreateTable
CREATE TABLE "ConflictRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "boardMemberId" TEXT,
    "trusteeName" TEXT NOT NULL,
    "matter" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "dateDeclared" TIMESTAMP(3) NOT NULL,
    "meetingDate" TIMESTAMP(3),
    "actionTaken" TEXT NOT NULL,
    "decision" TEXT,
    "status" "ConflictStatus" NOT NULL DEFAULT 'DECLARED',
    "minuteReference" TEXT,
    "nextReviewDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConflictRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "RiskCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "mitigation" TEXT NOT NULL,
    "owner" TEXT,
    "reviewDate" TIMESTAMP(3),
    "status" "RegisterStatus" NOT NULL DEFAULT 'OPEN',
    "boardMinuteReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "summary" TEXT NOT NULL,
    "actionTaken" TEXT,
    "outcome" TEXT,
    "status" "RegisterStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedByBoard" BOOLEAN NOT NULL DEFAULT false,
    "boardMinuteReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplaintRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundraisingRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "publicFacing" BOOLEAN NOT NULL DEFAULT true,
    "thirdPartyFundraiser" TEXT,
    "controls" TEXT,
    "complaintsReceived" BOOLEAN NOT NULL DEFAULT false,
    "reviewOutcome" TEXT,
    "status" "RegisterStatus" NOT NULL DEFAULT 'OPEN',
    "boardMinuteReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundraisingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnualReportReadiness" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "activitiesNarrative" TEXT,
    "publicBenefitStatement" TEXT,
    "beneficiariesSummary" TEXT,
    "financialStatementsApproved" BOOLEAN NOT NULL DEFAULT false,
    "annualReportUploaded" BOOLEAN NOT NULL DEFAULT false,
    "trusteeDetailsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "fundraisingReviewed" BOOLEAN NOT NULL DEFAULT false,
    "complaintsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "boardApprovalDate" TIMESTAMP(3),
    "filingStatus" "AnnualReportFilingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "filedDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnualReportReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialControlReview" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "bankReconciliationsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "dualAuthorisation" BOOLEAN NOT NULL DEFAULT false,
    "budgetApproved" BOOLEAN NOT NULL DEFAULT false,
    "managementAccountsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "reservesReviewed" BOOLEAN NOT NULL DEFAULT false,
    "restrictedFundsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "assetsInsuranceReviewed" BOOLEAN NOT NULL DEFAULT false,
    "payrollControlsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "fundraisingControlsReviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "reviewDate" TIMESTAMP(3),
    "minuteReference" TEXT,
    "actions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialControlReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConflictRecord_organisationId_idx" ON "ConflictRecord"("organisationId");

-- CreateIndex
CREATE INDEX "ConflictRecord_boardMemberId_idx" ON "ConflictRecord"("boardMemberId");

-- CreateIndex
CREATE INDEX "RiskRecord_organisationId_idx" ON "RiskRecord"("organisationId");

-- CreateIndex
CREATE INDEX "ComplaintRecord_organisationId_idx" ON "ComplaintRecord"("organisationId");

-- CreateIndex
CREATE INDEX "FundraisingRecord_organisationId_idx" ON "FundraisingRecord"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnualReportReadiness_organisationId_reportingYear_key" ON "AnnualReportReadiness"("organisationId", "reportingYear");

-- CreateIndex
CREATE INDEX "AnnualReportReadiness_organisationId_reportingYear_idx" ON "AnnualReportReadiness"("organisationId", "reportingYear");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialControlReview_organisationId_reportingYear_key" ON "FinancialControlReview"("organisationId", "reportingYear");

-- CreateIndex
CREATE INDEX "FinancialControlReview_organisationId_reportingYear_idx" ON "FinancialControlReview"("organisationId", "reportingYear");

-- AddForeignKey
ALTER TABLE "ConflictRecord" ADD CONSTRAINT "ConflictRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictRecord" ADD CONSTRAINT "ConflictRecord_boardMemberId_fkey" FOREIGN KEY ("boardMemberId") REFERENCES "BoardMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintRecord" ADD CONSTRAINT "ComplaintRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundraisingRecord" ADD CONSTRAINT "FundraisingRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnualReportReadiness" ADD CONSTRAINT "AnnualReportReadiness_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialControlReview" ADD CONSTRAINT "FinancialControlReview_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
